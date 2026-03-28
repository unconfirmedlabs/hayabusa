import { Hono } from 'hono';
import { cors } from 'hono/cors';
import pTimeout, { TimeoutError } from 'p-timeout';
import config from './config.json';

const BACKEND_TIMEOUT_MS = 5_000;
const POOL_SIZE = 3;
const EMA_ALPHA = 0.3;
const PROBE_INTERVAL_MS = 30_000;
const FAILURE_PENALTY_MS = 10_000;

// --- Backend health tracking (global, persists across requests in same isolate) ---

interface BackendStats {
	ema: number;
	consecutiveFailures: number;
	lastSuccessAt: number;
	lastObservedAt: number;
}

const backendStats = new Map<string, BackendStats>();
let lastProbeAt = 0;

function backendScore(url: string): number {
	const stats = backendStats.get(url);
	if (!stats) return 0; // unknown → best score (encourages exploration)
	return stats.ema + stats.consecutiveFailures * FAILURE_PENALTY_MS;
}

function selectPools(): { primary: string[]; fallback: string[] } {
	// Cold start: race all backends to gather initial data
	if (backendStats.size < config.backends.length) {
		return { primary: config.backends, fallback: [] };
	}
	const sorted = [...config.backends].sort((a, b) => backendScore(a) - backendScore(b));
	return {
		primary: sorted.slice(0, POOL_SIZE),
		fallback: sorted.slice(POOL_SIZE),
	};
}

function updateWinnerStats(backend: string, latency: number): void {
	const now = Date.now();
	const stats = backendStats.get(backend);
	if (stats) {
		stats.ema = stats.ema * (1 - EMA_ALPHA) + latency * EMA_ALPHA;
		stats.consecutiveFailures = 0;
		stats.lastSuccessAt = now;
		stats.lastObservedAt = now;
	} else {
		backendStats.set(backend, { ema: latency, consecutiveFailures: 0, lastSuccessAt: now, lastObservedAt: now });
	}
}

function markPoolFailure(backends: string[]): void {
	const now = Date.now();
	for (const url of backends) {
		const stats = backendStats.get(url);
		if (stats) {
			stats.consecutiveFailures++;
			stats.lastObservedAt = now;
		} else {
			backendStats.set(url, { ema: BACKEND_TIMEOUT_MS, consecutiveFailures: 1, lastSuccessAt: 0, lastObservedAt: now });
		}
	}
}

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
			'x-hayabusa-pool',
		],
	}),
);

app.get('/', (c) => c.text('hayabusa'));

// Probe all backends with GetServiceInfo and update health stats
async function probeBackends(): Promise<void> {
	const emptyFrame = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);
	const now = Date.now();

	const results = await Promise.allSettled(
		config.backends.map(async (backend) => {
			const start = performance.now();
			await pTimeout(
				fetch(`${backend}/sui.rpc.v2.LedgerService/GetServiceInfo`, {
					method: 'POST',
					headers: { 'content-type': 'application/grpc-web+proto', accept: 'application/grpc-web+proto' },
					body: emptyFrame,
				}),
				{ milliseconds: BACKEND_TIMEOUT_MS },
			);
			return { backend, latency: performance.now() - start };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const backend = config.backends[i];
		if (result.status === 'fulfilled') {
			updateWinnerStats(backend, result.value.latency);
		} else {
			const stats = backendStats.get(backend);
			if (stats) {
				stats.consecutiveFailures++;
				stats.lastObservedAt = now;
			} else {
				backendStats.set(backend, { ema: BACKEND_TIMEOUT_MS, consecutiveFailures: 1, lastSuccessAt: 0, lastObservedAt: now });
			}
		}
	}

	lastProbeAt = now;
}

// Latency check — probe all backends, return health stats
app.get('/latency', async (c) => {
	await probeBackends();
	const hashes = await getBackendHashes();
	const { primary } = selectPools();
	const primarySet = new Set(primary);

	const backends = config.backends.map((url) => {
		const stats = backendStats.get(url);
		const hash = hashes.get(url)!;
		return {
			id: hash,
			ema: stats ? Math.round(stats.ema * 10) / 10 : null,
			consecutiveFailures: stats?.consecutiveFailures ?? 0,
			score: Math.round(backendScore(url) * 10) / 10,
			pool: primarySet.has(url) ? 'primary' : 'fallback',
		};
	});

	backends.sort((a, b) => a.score - b.score);
	return c.json({ backends, probedAt: lastProbeAt });
});

// Race a subset of backends, return first successful response
async function raceBackends(
	backends: string[],
	path: string,
	headers: Headers,
	body: ArrayBuffer,
): Promise<{ res: Response; backend: string; latency: number }> {
	const start = performance.now();
	const controllers = backends.map(() => new AbortController());
	const promises = backends.map((backend, i) =>
		pTimeout(
			fetch(`${backend}${path}`, {
				method: 'POST',
				headers,
				body,
				signal: controllers[i].signal,
			}).then((res) => {
				if (!res.ok) throw new Error(`${backend} returned ${res.status}`);
				controllers.forEach((ctrl, j) => {
					if (j !== i) ctrl.abort();
				});
				return { res, backend, latency: performance.now() - start };
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

	// --- Lazy health probe (non-blocking, at most once per interval) ---
	const now = Date.now();
	if (now - lastProbeAt > PROBE_INTERVAL_MS) {
		lastProbeAt = now;
		c.executionCtx.waitUntil(probeBackends());
	}

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

	// Two-stage racing: primary pool (top N by health) → fallback pool
	const { primary, fallback } = selectPools();
	let backendRes: Response;
	let winningBackend: string;
	let pool: 'primary' | 'fallback' = 'primary';

	try {
		const winner = await raceBackends(primary, path, forwardHeaders, body);
		backendRes = winner.res;
		winningBackend = winner.backend;
		updateWinnerStats(winner.backend, winner.latency);
	} catch {
		markPoolFailure(primary);

		if (fallback.length > 0) {
			try {
				pool = 'fallback';
				const winner = await raceBackends(fallback, path, forwardHeaders, body);
				backendRes = winner.res;
				winningBackend = winner.backend;
				updateWinnerStats(winner.backend, winner.latency);
			} catch {
				markPoolFailure(fallback);
				return c.text('All backends failed', 502);
			}
		} else {
			return c.text('All backends failed', 502);
		}
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
	resHeaders.set('x-hayabusa-pool', pool);

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
