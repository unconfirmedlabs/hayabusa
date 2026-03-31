import { Hono } from 'hono';
import { cors } from 'hono/cors';
import pTimeout, { TimeoutError } from 'p-timeout';
import config from './config.json';

const POOL_SIZE = 3;
const EMA_ALPHA = 0.3;
const PROBE_INTERVAL_MS = 30_000;
const FAILURE_PENALTY_MS = 10_000;
const HEDGE_DELAY_1_MS = 20;
const HEDGE_DELAY_2_MS = 40;
const LATENCY_RING_SIZE = 20;
const EMA_WEIGHT = 0.7;
const P95_WEIGHT = 0.3;
const PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;

// --- Backend health tracking (global, persists across requests in same isolate) ---

interface BackendStats {
	ema: number;
	consecutiveFailures: number;
	lastSuccessAt: number;
	lastObservedAt: number;
	latencies: number[];
	latencyIdx: number;
}

const backendStats = new Map<string, BackendStats>();
let lastProbeAt = 0;

function computeP95(latencies: number[]): number {
	if (latencies.length === 0) return 0;
	const sorted = [...latencies].sort((a, b) => a - b);
	return sorted[Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1)];
}

function backendScore(url: string): number {
	const stats = backendStats.get(url);
	if (!stats) return 0; // unknown → best score (encourages exploration)
	const p95 = computeP95(stats.latencies);
	return stats.ema * EMA_WEIGHT + p95 * P95_WEIGHT + stats.consecutiveFailures * FAILURE_PENALTY_MS;
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
		if (stats.latencies.length < LATENCY_RING_SIZE) {
			stats.latencies.push(latency);
		} else {
			stats.latencies[stats.latencyIdx] = latency;
			stats.latencyIdx = (stats.latencyIdx + 1) % LATENCY_RING_SIZE;
		}
	} else {
		backendStats.set(backend, { ema: latency, consecutiveFailures: 0, lastSuccessAt: now, lastObservedAt: now, latencies: [latency], latencyIdx: 1 });
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
			backendStats.set(url, { ema: PROBE_TIMEOUT_MS, consecutiveFailures: 1, lastSuccessAt: 0, lastObservedAt: now, latencies: [], latencyIdx: 0 });
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
	CLOUDFLARE_ACCOUNT_ID: string;
	CLOUDFLARE_API_TOKEN: string;
	CACHE_KV?: KVNamespace;
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
			'x-hayabusa-fanout',
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
				{ milliseconds: PROBE_TIMEOUT_MS },
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
				backendStats.set(backend, { ema: PROBE_TIMEOUT_MS, consecutiveFailures: 1, lastSuccessAt: 0, lastObservedAt: now, latencies: [], latencyIdx: 0 });
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
			p95: stats ? Math.round(computeP95(stats.latencies) * 10) / 10 : null,
			consecutiveFailures: stats?.consecutiveFailures ?? 0,
			score: Math.round(backendScore(url) * 10) / 10,
			pool: primarySet.has(url) ? 'primary' : 'fallback',
		};
	});

	backends.sort((a, b) => a.score - b.score);
	return c.json({ backends, probedAt: lastProbeAt });
});

// Query Cloudflare Analytics Engine SQL API
async function queryAnalytics(env: Bindings, sql: string): Promise<{ data: Record<string, unknown>[]; rows: number }> {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
		body: sql,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Analytics Engine query failed (${res.status}): ${text}`);
	}
	return res.json();
}

// Cache stats endpoint — query analytics engine for hit/miss data
app.get('/cache', async (c) => {
	const hours = Math.min(Number(c.req.query('hours') || 24), 168); // max 7 days
	const dataset = config.dataset;

	const [overall, perMethod] = await Promise.all([
		queryAnalytics(
			c.env,
			`SELECT
				blob12 AS cache_status,
				COUNT() AS count,
				AVG(double1) AS avg_latency_ms
			FROM "${dataset}"
			WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
				AND blob12 != ''
			GROUP BY blob12`,
		),
		queryAnalytics(
			c.env,
			`SELECT
				blob1 AS service,
				blob2 AS method,
				blob12 AS cache_status,
				COUNT() AS count,
				AVG(double1) AS avg_latency_ms
			FROM "${dataset}"
			WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
				AND blob12 != ''
			GROUP BY blob1, blob2, blob12
			ORDER BY count DESC`,
		),
	]);

	// Compute overall hit rates (L1 = Cache API, L2 = KV, MISS = backend)
	const l1 = overall.data.find((r: any) => r.cache_status === 'L1');
	const l2 = overall.data.find((r: any) => r.cache_status === 'L2');
	const misses = overall.data.find((r: any) => r.cache_status === 'MISS');
	// Backwards compat: count old 'HIT' entries as L1
	const legacyHits = overall.data.find((r: any) => r.cache_status === 'HIT');
	const l1Count = Number(l1?.count ?? 0) + Number(legacyHits?.count ?? 0);
	const l2Count = Number(l2?.count ?? 0);
	const missCount = Number(misses?.count ?? 0);
	const total = l1Count + l2Count + missCount;

	// Group per-method stats
	const methods: Record<string, any> = {};
	for (const row of perMethod.data as any[]) {
		const key = `${row.service}/${row.method}`;
		if (!methods[key]) methods[key] = { l1: 0, l2: 0, misses: 0, avgLatency: { l1: 0, l2: 0, miss: 0 } };
		const entry = methods[key];
		const count = Number(row.count);
		const avgLat = Math.round(Number(row.avg_latency_ms) * 10) / 10;
		if (row.cache_status === 'L1' || row.cache_status === 'HIT') {
			entry.l1 += count;
			entry.avgLatency.l1 = avgLat;
		} else if (row.cache_status === 'L2') {
			entry.l2 += count;
			entry.avgLatency.l2 = avgLat;
		} else {
			entry.misses += count;
			entry.avgLatency.miss = avgLat;
		}
		const entryTotal = entry.l1 + entry.l2 + entry.misses;
		entry.hitRate = entryTotal > 0
			? Math.round(((entry.l1 + entry.l2) / entryTotal) * 1000) / 10
			: 0;
	}

	return c.json({
		window: `${hours}h`,
		overall: {
			total,
			l1: l1Count,
			l2: l2Count,
			misses: missCount,
			hitRate: total > 0 ? Math.round(((l1Count + l2Count) / total) * 1000) / 10 : 0,
			avgLatency: {
				l1: Math.round(Number(l1?.avg_latency_ms ?? legacyHits?.avg_latency_ms ?? 0) * 10) / 10,
				l2: Math.round(Number(l2?.avg_latency_ms ?? 0) * 10) / 10,
				miss: Math.round(Number(misses?.avg_latency_ms ?? 0) * 10) / 10,
			},
		},
		methods,
	});
});

// Race backends with hedged requests: fire the best backend first, only fan out
// if it's slow. Reduces duplicate origin load while preserving tail latency.
async function raceBackends(
	backends: string[],
	path: string,
	headers: Headers,
	body: ArrayBuffer,
	timeoutMs: number,
): Promise<{ res: Response; backend: string; latency: number; backendsLaunched: number }> {
	const start = performance.now();
	const controllers = backends.map(() => new AbortController());
	let settled = false;
	let launched = 0;

	const launch = (i: number) => {
		launched++;
		return pTimeout(
			fetch(`${backends[i]}${path}`, {
				method: 'POST',
				headers,
				body,
				signal: controllers[i].signal,
			}).then((res) => {
				if (!res.ok) throw new Error(`${backends[i]} returned ${res.status}`);
				settled = true;
				controllers.forEach((ctrl, j) => {
					if (j !== i) ctrl.abort();
				});
				return { res, backend: backends[i], latency: performance.now() - start, backendsLaunched: launched };
			}),
			{ milliseconds: timeoutMs },
		);
	};

	// Cold start (all backends in pool): race all simultaneously to gather stats fast
	if (backends.length > POOL_SIZE) {
		return Promise.any(backends.map((_, i) => launch(i)));
	}

	// Hedged requests: stagger launches so most requests are single-shot
	const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
	const hedgeDelays = [0, HEDGE_DELAY_1_MS, HEDGE_DELAY_2_MS];
	const promises = backends.map((_, i) => {
		const d = hedgeDelays[Math.min(i, hedgeDelays.length - 1)];
		if (d === 0) return launch(i);
		return delay(d).then(() => {
			if (settled) throw new Error('hedged: already settled');
			return launch(i);
		});
	});

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
	const timeouts = (config as any).timeouts as Record<string, number> | undefined;
	const timeoutMs = timeouts?.[method] ?? timeouts?.default ?? DEFAULT_TIMEOUT_MS;

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
	const noCache = c.req.header('x-hayabusa-no-cache') !== undefined;
	const cacheCheck = CACHE_CHECKS.get(path);
	const isCacheable = !noCache && (cacheCheck ? cacheCheck(body) : false);
	let cacheKey = '';

	if (isCacheable) {
		cacheKey = await buildCacheKey(path, body);

		// L1: Cache API (per-colo, ~0ms reads)
		const cachedRes = await caches.default.match(new Request(cacheKey));
		if (cachedRes) {
			const latency = performance.now() - start;
			const cf = c.req.raw.cf;
			const clientIp = c.req.header('cf-connecting-ip') ?? '';
			c.executionCtx.waitUntil(
				hashStr(clientIp).then((ipHash) => {
					c.env.ANALYTICS.writeDataPoint({
						blobs: [
							service, method,
							cachedRes.headers.get('grpc-status') ?? '',
							ipHash,
							(cf?.country as string) ?? '', (cf?.continent as string) ?? '',
							(cf?.colo as string) ?? '', (cf?.asOrganization as string) ?? '',
							(cf?.httpProtocol as string) ?? '', (cf?.tlsVersion as string) ?? '',
							'', 'L1',
						],
						doubles: [
							latency, (cf?.asn as number) ?? 0,
							((cf?.clientTcpRtt as number) ?? (cf?.clientQuicRtt as number)) ?? 0, 0,
						],
					});
				}),
			);

			const resHeaders = new Headers();
			for (const [key, value] of cachedRes.headers) {
				resHeaders.set(key, value);
			}
			resHeaders.set('x-hayabusa-cache', 'L1');
			resHeaders.set('x-hayabusa-latency', latency.toFixed(1));

			return new Response(cachedRes.body, {
				status: cachedRes.status,
				headers: resHeaders,
			});
		}

		// L2: Workers KV (global, ~10-20ms reads)
		if (c.env.CACHE_KV) {
			try {
				const kvKey = cacheKey.slice('https://hayabusa-cache'.length);
				const { value: kvBody, metadata: kvMeta } = await c.env.CACHE_KV.getWithMetadata<Record<string, string>>(kvKey, 'arrayBuffer');

				if (kvBody) {
					const latency = performance.now() - start;

					// Reconstruct response headers from KV metadata
					const resHeaders = new Headers();
					if (kvMeta) {
						for (const [k, v] of Object.entries(kvMeta)) {
							resHeaders.set(k, v);
						}
					}
					resHeaders.set('x-hayabusa-cache', 'L2');
					resHeaders.set('x-hayabusa-latency', latency.toFixed(1));

					// Populate L1 for next time (non-blocking)
					const l1Res = new Response(kvBody.slice(0), { status: 200, headers: resHeaders });
					c.executionCtx.waitUntil(caches.default.put(new Request(cacheKey), l1Res));

					// Log analytics
					const cf = c.req.raw.cf;
					const clientIp = c.req.header('cf-connecting-ip') ?? '';
					c.executionCtx.waitUntil(
						hashStr(clientIp).then((ipHash) => {
							c.env.ANALYTICS.writeDataPoint({
								blobs: [
									service, method,
									kvMeta?.['grpc-status'] ?? '',
									ipHash,
									(cf?.country as string) ?? '', (cf?.continent as string) ?? '',
									(cf?.colo as string) ?? '', (cf?.asOrganization as string) ?? '',
									(cf?.httpProtocol as string) ?? '', (cf?.tlsVersion as string) ?? '',
									'', 'L2',
								],
								doubles: [
									latency, (cf?.asn as number) ?? 0,
									((cf?.clientTcpRtt as number) ?? (cf?.clientQuicRtt as number)) ?? 0, 0,
								],
							});
						}),
					);

					return new Response(kvBody, { status: 200, headers: resHeaders });
				}
			} catch {
				// KV read failed, fall through to backend racing
			}
		}
	}

	// Two-stage racing: primary pool (top N by health) → fallback pool
	const { primary, fallback } = selectPools();
	let backendRes: Response;
	let winningBackend: string;
	let pool: 'primary' | 'fallback' = 'primary';
	let backendsLaunched = 0;

	try {
		const winner = await raceBackends(primary, path, forwardHeaders, body, timeoutMs);
		backendRes = winner.res;
		winningBackend = winner.backend;
		backendsLaunched = winner.backendsLaunched;
		updateWinnerStats(winner.backend, winner.latency);
	} catch {
		markPoolFailure(primary);

		if (fallback.length > 0) {
			try {
				pool = 'fallback';
				const winner = await raceBackends(fallback, path, forwardHeaders, body, timeoutMs);
				backendRes = winner.res;
				winningBackend = winner.backend;
				backendsLaunched = winner.backendsLaunched;
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
					backendsLaunched, // double4: backends launched (hedging fanout)
				],
			});
		}),
	);

	// Return backend response — only forward gRPC protocol headers
	const resHeaders = new Headers();
	for (const [key, value] of backendRes.headers) {
		if (BACKEND_HEADER_ALLOWLIST.has(key)) resHeaders.set(key, value);
	}

	// Normalize content-type: some fullnodes return application/grpc instead
	// of application/grpc-web, which grpc-web clients reject
	const ct = resHeaders.get('content-type');
	if (ct === 'application/grpc') {
		resHeaders.set('content-type', 'application/grpc-web');
	} else if (ct === 'application/grpc+proto') {
		resHeaders.set('content-type', 'application/grpc-web+proto');
	}
	resHeaders.set('x-hayabusa-backend', backendHash);
	resHeaders.set('x-hayabusa-latency', latency.toFixed(1));
	resHeaders.set('x-hayabusa-pool', pool);
	resHeaders.set('x-hayabusa-fanout', String(backendsLaunched));

	// Cache immutable responses (only successful gRPC status)
	if (isCacheable) {
		resHeaders.set('x-hayabusa-cache', 'MISS');

		const grpcStatusVal = backendRes.headers.get('grpc-status');
		if (!grpcStatusVal || grpcStatusVal === '0') {
			const cachedBody = await backendRes.clone().arrayBuffer();

			// L1: Cache API (per-colo)
			const cacheRes = new Response(cachedBody, {
				status: backendRes.status,
				headers: resHeaders,
			});
			c.executionCtx.waitUntil(caches.default.put(new Request(cacheKey), cacheRes));

			// L2: Workers KV (global)
			if (c.env.CACHE_KV) {
				const kvKey = cacheKey.slice('https://hayabusa-cache'.length);
				const metadata: Record<string, string> = {};
				for (const key of BACKEND_HEADER_ALLOWLIST) {
					const val = resHeaders.get(key);
					if (val) metadata[key] = val;
				}
				c.executionCtx.waitUntil(c.env.CACHE_KV.put(kvKey, cachedBody, { metadata, expirationTtl: 30 * 86400 }));
			}
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
