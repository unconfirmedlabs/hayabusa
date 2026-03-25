# Hayabusa

A Sui gRPC proxy that races requests to multiple backend fullnodes and returns the fastest response. Runs on Cloudflare Workers.

## How it works

Sui's gRPC API uses the [gRPC-Web](https://github.com/grpc/grpc-web) protocol — standard HTTP POST requests with binary protobuf bodies. Hayabusa exploits this by fanning out every incoming request to all configured backends simultaneously using `Promise.any`. The first successful response wins; the rest are aborted via `AbortController`.

```
Client (Sui SDK) ──gRPC-Web──▶ Hayabusa (CF Worker) ──┬──▶ Backend A
                                      │                ├──▶ Backend B
                                      │                └──▶ Backend C
                                      │                       │
                                      │◀── fastest response ──┘
                                      │
                                      └──▶ Analytics Engine
```

This is fully transparent to the client — any Sui SDK or gRPC-Web client works without modification. Just point the `baseUrl` at Hayabusa instead of a fullnode.

## Features

- **Request racing** — fan out to N backends, return the fastest response, abort the rest
- **Protocol transparent** — forwards gRPC-Web requests as-is, no protobuf parsing
- **Usage analytics** — logs every request to Cloudflare Analytics Engine with method, latency, geo, and hashed client IP
- **Latency endpoint** — `GET /latency` pings all backends and reports timing
- **CORS** — browser-ready out of the box
- **Zero runtime dependencies** — just [Hono](https://hono.dev) on Cloudflare Workers

## Response headers

Every proxied response includes:

| Header | Description |
|--------|-------------|
| `x-hayabusa-backend` | SHA-256 hash (16 chars) of the winning backend URL |
| `x-hayabusa-latency` | Total proxy latency in milliseconds |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/latency` | Ping all backends, return sorted latency report |
| `POST` | `/sui.rpc.v2.*` | gRPC-Web proxy (races all backends) |

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

Hayabusa keeps config files outside the repo to avoid leaking backend URLs in open source. Create your config directory and files:

```sh
mkdir -p ~/Documents/sona/hayabusa
```

**`~/Documents/sona/hayabusa/config.json`** — backend URLs:

```json
{
  "backends": [
    "https://fullnode.testnet.sui.io",
    "https://your-rpc-provider.example.com"
  ]
}
```

**`~/Documents/sona/hayabusa/wrangler.jsonc`** — Cloudflare Worker config:

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
      "dataset": "hayabusa_usage"
    }
  ]
}
```

> **Note:** The `main` field must be an absolute path to `src/index.ts` since wrangler resolves paths relative to the config file location.

### Development

```sh
bun run dev
```

This syncs `config.json` into the build and starts the local dev server.

### Deploy

```sh
bun run deploy
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
| blob11 | Winning backend hash |
| double1 | Response latency (ms) |
| double2 | ASN number |
| double3 | Client RTT (ms) |

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
