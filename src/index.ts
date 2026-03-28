import { Hono } from 'hono';
import { cors } from 'hono/cors';
import pTimeout, { TimeoutError } from 'p-timeout';
import pRetry from 'p-retry';
import config from './config.json';

const BACKEND_TIMEOUT_MS = 5_000;
const RACE_RETRIES = 2;

// Only forward gRPC protocol headers from backends — strip node-specific and infrastructure headers
const BACKEND_HEADER_ALLOWLIST = new Set([
	'content-type',
	'grpc-status',
	'grpc-message',
	'grpc-status-details-bin',
	'grpc-encoding',
]);

// Cache checks: returns true if the request body represents an immutable query.
// Tier 1 methods are always immutable. Tier 2 methods require inspecting the protobuf
// request body to check for version-pinning fields.
type CacheCheck = (body: ArrayBuffer) => boolean;
const ALWAYS: CacheCheck = () => true;

const CACHE_CHECKS = new Map<string, CacheCheck>([
	// Tier 1: always immutable
	['/sui.rpc.v2.LedgerService/GetTransaction', ALWAYS],
	['/sui.rpc.v2.LedgerService/BatchGetTransactions', ALWAYS],
	['/sui.rpc.v2.MovePackageService/GetPackage', ALWAYS],
	['/sui.rpc.v2.MovePackageService/GetDatatype', ALWAYS],
	['/sui.rpc.v2.MovePackageService/GetFunction', ALWAYS],
	// Tier 2: immutable when version/id fields are present in request
	['/sui.rpc.v2.LedgerService/GetObject', (body) => grpcProtoHasField(body, 2)], // version
	['/sui.rpc.v2.LedgerService/GetCheckpoint', (body) => grpcProtoHasField(body, 1) || grpcProtoHasField(body, 2)], // sequence_number | digest
]);

type Bindings = {
	ANALYTICS: AnalyticsEngineDataset;
};

const app = new Hono<{ Bindings: Bindings }>();

// Cache backend hashes across requests within the same Worker instance.
let _backendHashes: Map<string, string> | null = null;

async function getBackendHashes(): Promise<Map<string, string>> {
	if (_backendHashes) return _backendHashes;
	_backendHashes = new Map();
	for (const b of config.backends) {
		_backendHashes.set(b, await hashStr(b));
	}
	return _backendHashes;
}

// CORS for gRPC-Web browser clients
app.use(
	'/sui.rpc.v2.*',
	cors({
		origin: '*',
		allowMethods: ['POST', 'OPTIONS'],
		allowHeaders: ['content-type', 'x-grpc-web', 'grpc-timeout', 'grpc-encoding', 'x-user-agent'],
		exposeHeaders: [
			'grpc-status',
			'grpc-message',
			'grpc-encoding',
			'content-type',
			'x-hayabusa-backend',
			'x-hayabusa-latency',
			'x-hayabusa-cache',
		],
	}),
);

app.get('/', (c) => c.text('hayabusa'));

// Latency check — ping all backends with GetServiceInfo and report timing
app.get('/latency', async (c) => {
	const hashes = await getBackendHashes();

	// Empty gRPC-Web frame for GetServiceInfo (no fields needed)
	const emptyFrame = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);

	const results = await Promise.allSettled(
		config.backends.map(async (backend) => {
			const start = performance.now();
			const res = await pTimeout(
				fetch(`${backend}/sui.rpc.v2.LedgerService/GetServiceInfo`, {
					method: 'POST',
					headers: {
						'content-type': 'application/grpc-web+proto',
						accept: 'application/grpc-web+proto',
					},
					body: emptyFrame,
				}),
				{ milliseconds: BACKEND_TIMEOUT_MS },
			);
			const latency = performance.now() - start;
			return { id: hashes.get(backend)!, latency: Math.round(latency * 10) / 10, status: res.status };
		}),
	);

	const latencies = results.map((r) => {
		if (r.status === 'fulfilled') return r.value;
		const error = r.reason instanceof TimeoutError ? 'timeout' : (r.reason?.message ?? 'failed');
		return { id: 'unknown', latency: null, status: null, error };
	});

	// Sort by latency (fastest first), errors last
	latencies.sort((a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity));

	return c.json({ backends: latencies });
});

// Race all backends, return first successful response
async function raceBackends(
	path: string,
	headers: Headers,
	body: ArrayBuffer,
): Promise<{ res: Response; backend: string }> {
	const controllers = config.backends.map(() => new AbortController());
	const promises = config.backends.map((backend, i) =>
		pTimeout(
			fetch(`${backend}${path}`, {
				method: 'POST',
				headers,
				body,
				signal: controllers[i].signal,
			}).then((res) => {
				if (!res.ok) throw new Error(`${backend} returned ${res.status}`);
				// Abort all other in-flight requests
				controllers.forEach((ctrl, j) => {
					if (j !== i) ctrl.abort();
				});
				return { res, backend };
			}),
			{ milliseconds: BACKEND_TIMEOUT_MS },
		),
	);

	return Promise.any(promises);
}

// gRPC-Web proxy — race all backends with retry
app.post('/sui.rpc.v2.*', async (c) => {
	const start = performance.now();
	const path = new URL(c.req.url).pathname;
	const hashes = await getBackendHashes();

	// Parse service and method from path
	const match = path.match(/\/sui\.rpc\.v2\.(\w+)\/(\w+)/);
	const service = match?.[1] ?? 'unknown';
	const method = match?.[2] ?? 'unknown';

	// Forward headers
	const forwardHeaders = new Headers();
	for (const key of ['content-type', 'accept', 'x-grpc-web', 'grpc-timeout', 'grpc-encoding', 'x-user-agent']) {
		const val = c.req.header(key);
		if (val) forwardHeaders.set(key, val);
	}

	// Buffer request body so we can send it to multiple backends
	const body = await c.req.arrayBuffer();

	// --- Cache layer ---
	const cacheCheck = CACHE_CHECKS.get(path);
	const isCacheable = cacheCheck ? cacheCheck(body) : false;
	let cacheKey = '';

	if (isCacheable) {
		cacheKey = await buildCacheKey(path, body);
		const cachedRes = await caches.default.match(new Request(cacheKey));

		if (cachedRes) {
			const latency = performance.now() - start;

			// Log analytics for cache hit (non-blocking)
			const cf = c.req.raw.cf;
			const clientIp = c.req.header('cf-connecting-ip') ?? '';
			c.executionCtx.waitUntil(
				hashStr(clientIp).then((ipHash) => {
					c.env.ANALYTICS.writeDataPoint({
						blobs: [
							service, // blob1: service name
							method, // blob2: method name
							cachedRes.headers.get('grpc-status') ?? '', // blob3: grpc status
							ipHash, // blob4: hashed client IP
							(cf?.country as string) ?? '', // blob5: country
							(cf?.continent as string) ?? '', // blob6: continent
							(cf?.colo as string) ?? '', // blob7: CF data center
							(cf?.asOrganization as string) ?? '', // blob8: ASN org
							(cf?.httpProtocol as string) ?? '', // blob9: HTTP protocol
							(cf?.tlsVersion as string) ?? '', // blob10: TLS version
							'', // blob11: no winning backend (cache hit)
							'HIT', // blob12: cache status
						],
						doubles: [
							latency, // double1: response latency (ms)
							(cf?.asn as number) ?? 0, // double2: ASN number
							((cf?.clientTcpRtt as number) ?? (cf?.clientQuicRtt as number)) ?? 0, // double3: client RTT
						],
					});
				}),
			);

			const resHeaders = new Headers();
			for (const [key, value] of cachedRes.headers) {
				resHeaders.set(key, value);
			}
			resHeaders.set('x-hayabusa-cache', 'HIT');
			resHeaders.set('x-hayabusa-latency', latency.toFixed(1));
			resHeaders.set('cache-control', 'public, max-age=31536000, immutable');

			return new Response(cachedRes.body, {
				status: cachedRes.status,
				headers: resHeaders,
			});
		}
	}

	// Race with retries — if all backends fail, retry the whole fan-out
	let backendRes: Response;
	let winningBackend: string;
	try {
		const winner = await pRetry(() => raceBackends(path, forwardHeaders, body), {
			retries: RACE_RETRIES,
			minTimeout: 0,
		});
		backendRes = winner.res;
		winningBackend = winner.backend;
	} catch {
		return c.text('All backends failed', 502);
	}

	const latency = performance.now() - start;
	const grpcStatus = backendRes.headers.get('grpc-status') ?? '';
	const backendHash = hashes.get(winningBackend)!;

	// Log analytics (non-blocking)
	const cf = c.req.raw.cf;
	const clientIp = c.req.header('cf-connecting-ip') ?? '';
	c.executionCtx.waitUntil(
		hashStr(clientIp).then((ipHash) => {
			c.env.ANALYTICS.writeDataPoint({
				blobs: [
					service, // blob1: service name
					method, // blob2: method name
					grpcStatus, // blob3: grpc status
					ipHash, // blob4: hashed client IP
					(cf?.country as string) ?? '', // blob5: country
					(cf?.continent as string) ?? '', // blob6: continent
					(cf?.colo as string) ?? '', // blob7: CF data center
					(cf?.asOrganization as string) ?? '', // blob8: ASN org
					(cf?.httpProtocol as string) ?? '', // blob9: HTTP protocol
					(cf?.tlsVersion as string) ?? '', // blob10: TLS version
					backendHash, // blob11: winning backend
					isCacheable ? 'MISS' : '', // blob12: cache status
				],
				doubles: [
					latency, // double1: response latency (ms)
					(cf?.asn as number) ?? 0, // double2: ASN number
					((cf?.clientTcpRtt as number) ?? (cf?.clientQuicRtt as number)) ?? 0, // double3: client RTT
				],
			});
		}),
	);

	// Return backend response — only forward gRPC protocol headers
	const resHeaders = new Headers();
	for (const [key, value] of backendRes.headers) {
		if (BACKEND_HEADER_ALLOWLIST.has(key)) resHeaders.set(key, value);
	}
	resHeaders.set('x-hayabusa-backend', backendHash);
	resHeaders.set('x-hayabusa-latency', latency.toFixed(1));

	// Cache immutable responses (only successful gRPC status)
	if (isCacheable) {
		resHeaders.set('x-hayabusa-cache', 'MISS');
		resHeaders.set('cache-control', 'public, max-age=31536000, immutable');

		const grpcStatusVal = backendRes.headers.get('grpc-status');
		if (!grpcStatusVal || grpcStatusVal === '0') {
			const cacheRes = new Response(await backendRes.clone().arrayBuffer(), {
				status: backendRes.status,
				headers: resHeaders,
			});
			c.executionCtx.waitUntil(caches.default.put(new Request(cacheKey), cacheRes));
		}
	}

	return new Response(backendRes.body, {
		status: backendRes.status,
		headers: resHeaders,
	});
});

// Minimal protobuf wire format scanner — checks if a top-level field number
// is present in a gRPC-Web framed protobuf message. No dependencies needed:
// just reads varint tags and skips values by wire type.
function grpcProtoHasField(grpcBody: ArrayBuffer, fieldNumber: number): boolean {
	const buf = new Uint8Array(grpcBody);
	if (buf.length < 5 || buf[0] !== 0x00) return false;
	const msgLen = (buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4];
	const end = Math.min(5 + msgLen, buf.length);
	let pos = 5;
	while (pos < end) {
		let tag = 0, shift = 0;
		while (pos < end) {
			const b = buf[pos++];
			tag |= (b & 0x7f) << shift;
			if ((b & 0x80) === 0) break;
			shift += 7;
		}
		if ((tag >> 3) === fieldNumber) return true;
		switch (tag & 0x7) {
			case 0: while (pos < end && (buf[pos++] & 0x80) !== 0) {} break; // varint
			case 1: pos += 8; break; // 64-bit
			case 2: { // length-delimited
				let len = 0; shift = 0;
				while (pos < end) {
					const b = buf[pos++];
					len |= (b & 0x7f) << shift;
					if ((b & 0x80) === 0) break;
					shift += 7;
				}
				pos += len;
				break;
			}
			case 5: pos += 4; break; // 32-bit
			default: return false; // unknown wire type
		}
	}
	return false;
}

async function buildCacheKey(path: string, body: ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', body);
	const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `https://hayabusa-cache${path}/${hex}`;
}

async function hashStr(input: string): Promise<string> {
	if (!input) return '';
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest('SHA-256', data);
	const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return hex.slice(0, 16);
}

export default app;
