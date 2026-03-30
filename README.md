# Hayabusa

A Sui gRPC proxy that races requests to multiple backend fullnodes and returns the fastest response. Runs on Cloudflare Workers.

## How it works

Sui's gRPC API uses the [gRPC-Web](https://github.com/grpc/grpc-web) protocol — standard HTTP POST requests with binary protobuf bodies. Hayabusa tracks backend health over time and uses hedged requests to minimize latency while reducing unnecessary duplicate load on backends.

```
Client (Sui SDK) ──gRPC-Web──▶ Hayabusa (CF Worker) ──┬──▶ L1 Cache (Cache API, per-colo)
                                      │                ├──▶ L2 Cache (Workers KV, global)
                                      │                ├──▶ Primary pool (top 3, hedged)
                                      │                │     fastest response ──┐
                                      │                └──▶ Fallback pool       │
                                      │                     (if primary fails)  │
                                      │◀────────────────────────────────────────┘
                                      │
                                      └──▶ Analytics Engine
```

This is fully transparent to the client — any Sui SDK or gRPC-Web client works without modification. Just point the `baseUrl` at Hayabusa instead of a fullnode.

## Features

- **Hedged requests** — sends to the best backend first, only fans out to 2nd/3rd if it's slow (20ms/40ms delays), cutting duplicate origin load by ~50-60%
- **Two-tier caching** — immutable gRPC responses cached in L1 (Cache API, per-colo) and L2 (Workers KV, global with 30-day TTL)
- **Smart backend selection** — tracks latency via EMA, sorts backends by health score, automatic fallback pool
- **Header sanitization** — only gRPC protocol headers forwarded from backends
- **Usage analytics** — logs every request to Cloudflare Analytics Engine with method, latency, geo, cache tier, and hedging fanout
- **Health monitoring** — `GET /latency` probes all backends and returns health stats with pool assignments
- **CORS** — browser-ready out of the box

## Caching

Sui's gRPC API has several methods that return permanently immutable data. Hayabusa caches these using two tiers:

1. **L1: CF Cache API** — per-datacenter cache, ~0ms reads. Keyed on URL path + SHA-256 of the request body.
2. **L2: Workers KV** — globally replicated cache, ~10-20ms reads, 30-day TTL. L2 hits automatically populate L1 for subsequent requests in the same colo.

Since gRPC-Web uses POST requests, browser caching and Cloudflare's CDN cache are not applicable. The two-tier approach ensures fast local reads (L1) while sharing cache entries across all Cloudflare data centers (L2).

### Cached methods

**Layer 1 — always immutable** (no request inspection needed):

| Method | Why immutable |
|--------|--------------|
| `LedgerService/GetTransaction` | Content-addressed by digest |
| `LedgerService/BatchGetTransactions` | Content-addressed by digest |
| `MovePackageService/GetPackage` | Package storage IDs are immutable once published |
| `MovePackageService/GetDatatype` | Datatype definitions within a package never change |
| `MovePackageService/GetFunction` | Function definitions within a package never change |

**Layer 2 — conditionally immutable** (inspects protobuf request body):

| Method | Cached when |
|--------|------------|
| `LedgerService/GetObject` | `version` field is set (object at a specific version is frozen) |
| `LedgerService/GetCheckpoint` | `sequence_number` or `digest` is provided (not "latest") |

Layer 2 uses a minimal protobuf wire format scanner (~30 lines, zero dependencies) to check for the presence of version-pinning fields. Only successful gRPC responses (`grpc-status: 0`) are cached. Errors are never stored.

## Backend Selection

### Hedged requests

Instead of racing all 3 primary backends simultaneously (which triples origin load), Hayabusa uses hedged requests inspired by Google's [The Tail at Scale](https://research.google/pubs/the-tail-at-scale/):

1. Send to the **best backend** at t=0
2. If no response by **t=20ms**, launch the 2nd backend
3. If still no response by **t=40ms**, launch the 3rd backend
4. First success wins; all others are aborted via `AbortController`

This keeps most requests single-shot (~70-80% fanout=1) while still protecting tail latency. During cold start, all backends are raced simultaneously to gather initial latency data.

### Tail-aware health scoring

Hayabusa tracks backend health using a blend of average and tail latency. Each backend maintains an EMA of response latency plus a ring buffer of the last 20 latencies for p95 calculation:

```
score = ema × 0.7 + p95 × 0.3 + consecutive_failures × 10s
```

A backend with decent average latency but ugly p95 gets penalized — consistent backends are preferred over ones that spike. Backends are sorted by score and split into two pools:

- **Primary pool** — top 3 backends by score, hedged on every request
- **Fallback pool** — remaining backends, used only if the primary pool fails entirely

Stats are stored in-memory (global variables shared across requests within the same CF Worker isolate) and rebuilt automatically on cold start.

### Method-specific timeouts

Backend timeouts are configured per-method in `config.json`, with a `default` fallback for unlisted methods. This lets you set tight timeouts for fast reads while giving heavier operations more headroom:

```json
{
  "timeouts": {
    "default": 3000,
    "GetObject": 500,
    "GetTransaction": 500,
    "GetCheckpoint": 500
  }
}
```

Tighter timeouts make failover happen sooner when a backend is effectively dead for interactive traffic. Combined with hedging, a slow backend gets replaced within 20-40ms while the hard cutoff prevents wasting resources on a request that's already too slow to be useful.

### Health probing

A background probe runs at most once every 30 seconds, triggered lazily by incoming requests via `waitUntil` (non-blocking). The probe pings all backends with `GetServiceInfo` and updates their EMA and failure stats. The `/latency` endpoint also triggers a synchronous probe and returns full health data.

### Cold start

When a fresh isolate has no stats, all backends are placed in the primary pool and raced simultaneously. Stats converge within 1-2 requests.

## Response headers

Every proxied response includes:

| Header | Description |
|--------|-------------|
| `x-hayabusa-backend` | SHA-256 hash (16 chars) of the winning backend URL |
| `x-hayabusa-latency` | Total proxy latency in milliseconds |
| `x-hayabusa-cache` | `L1`, `L2`, or `MISS` (only present on cacheable methods) |
| `x-hayabusa-pool` | `primary` or `fallback` — which pool the winning backend came from |
| `x-hayabusa-fanout` | Number of backends actually launched (hedging fanout) |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/latency` | Probe all backends, return health stats with pool assignments |
| `GET` | `/cache` | Cache hit/miss stats from Analytics Engine (L1/L2/MISS breakdown) |
| `POST` | `/sui.rpc.v2.*` | gRPC-Web proxy |

## Setup

### Prerequisites

- [Bun](https://bun.sh)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (included as devDependency)
- A Cloudflare account with a configured zone

### Install

```sh
bun install
```

### Configuration

Hayabusa keeps config files outside the repo to avoid leaking backend URLs in open source. Create your config directory:

```sh
mkdir -p ~/my-hayabusa-config
```

**`config.json`** — backend URLs, analytics dataset, and timeouts:

```json
{
  "dataset": "hayabusa",
  "backends": [
    "https://fullnode.testnet.sui.io",
    "https://your-rpc-provider.example.com"
  ],
  "timeouts": {
    "default": 3000,
    "GetObject": 500,
    "GetTransaction": 500,
    "GetCheckpoint": 500,
    "GetServiceInfo": 500,
    "GetPackage": 500,
    "GetDatatype": 500,
    "GetFunction": 500
  }
}
```

**`wrangler.jsonc`** — Cloudflare Worker config:

```jsonc
{
  "name": "hayabusa",
  "main": "/absolute/path/to/hayabusa/src/index.ts",
  "compatibility_date": "2026-03-24",
  "routes": [
    { "pattern": "your-domain.example.com", "custom_domain": true }
  ],
  "analytics_engine_datasets": [
    {
      "binding": "ANALYTICS",
      "dataset": "hayabusa"
    }
  ],
  "kv_namespaces": [
    {
      "binding": "CACHE_KV",
      "id": "<your-kv-namespace-id>"
    }
  ]
}
```

> **Note:** The `main` field must be an absolute path to `src/index.ts` since wrangler resolves paths relative to the config file location.

To create a KV namespace:

```sh
bunx wrangler kv namespace create hayabusa-cache
```

The `CACHE_KV` binding is optional — if not configured, Hayabusa falls back to L1-only caching (Cache API).

### Environment variables

Create a `.env` file in your config directory (or its parent):

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_ACCOUNT_ID` | Required for the `/cache` analytics endpoint |
| `CLOUDFLARE_API_TOKEN` | Required for the `/cache` analytics endpoint |

### Development

```sh
bun run dev
```

### Deploy

```sh
bun run deploy -- --config ~/my-hayabusa-config
```

### Testing

```sh
bun test.ts
```

Sends raw gRPC-Web requests to the local proxy and reports backend racing results.

## Analytics schema

Every proxied request logs a data point to Cloudflare Analytics Engine:

| Field | Value |
|-------|-------|
| blob1 | Service name (e.g., `LedgerService`) |
| blob2 | Method name (e.g., `GetObject`) |
| blob3 | gRPC status |
| blob4 | SHA-256 hashed client IP (16 chars) |
| blob5 | Country code |
| blob6 | Continent |
| blob7 | Cloudflare data center (colo) |
| blob8 | ASN organization |
| blob9 | HTTP protocol |
| blob10 | TLS version |
| blob11 | Winning backend hash (empty on cache hit) |
| blob12 | Cache status (`L1`, `L2`, `MISS`, or empty for non-cacheable) |
| double1 | Response latency (ms) |
| double2 | ASN number |
| double3 | Client RTT (ms) |
| double4 | Backends launched (hedging fanout) |

## Usage with Sui SDK

```typescript
import { SuiGrpcClient } from '@mysten/sui/grpc';

const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://your-hayabusa-domain.example.com',
});

const info = await client.ledgerService.getServiceInfo({});
```

## License

Apache-2.0
