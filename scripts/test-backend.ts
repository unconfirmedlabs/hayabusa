#!/usr/bin/env bun
/**
 * Test a Sui backend for gRPC-web compatibility before adding to config.
 *
 * Usage:
 *   bun scripts/test-backend.ts https://fullnode.mainnet.sui.io
 *   bun scripts/test-backend.ts https://fullnode.mainnet.sui.io --regions ams,lhr,dfw
 *
 * Tests:
 *   1. Direct gRPC-web request from this machine
 *   2. Via Hayabusa /debug/backends from multiple CF edge regions (via Fly.io)
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcWebFetchTransport } from "@protobuf-ts/grpcweb-transport";

const HAYABUSA_API = "https://hayabusa-benchmark-api.fly.dev";
const DEFAULT_REGIONS = ["ams", "dfw", "nrt", "syd", "gru", "jnb"];

function parseArgs() {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.startsWith("https://"));
  if (!url) {
    console.error("Usage: bun scripts/test-backend.ts <backend-url> [--regions ams,lhr,dfw]");
    process.exit(1);
  }
  const regIdx = args.indexOf("--regions");
  const regions = regIdx !== -1 && args[regIdx + 1] ? args[regIdx + 1].split(",") : DEFAULT_REGIONS;
  return { url, regions };
}

async function testDirect(url: string) {
  console.log(`\n--- Direct test: ${url} ---\n`);

  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await globalThis.fetch(input, init);
    const ct = res.headers.get("content-type");
    const grpcStatus = res.headers.get("grpc-status");
    const grpcEncoding = res.headers.get("grpc-encoding");
    console.log(`  content-type: ${ct}`);
    if (grpcEncoding) console.log(`  grpc-encoding: ${grpcEncoding}`);
    if (grpcStatus) console.log(`  grpc-status: ${grpcStatus}`);
    return res;
  };

  const transport = new GrpcWebFetchTransport({
    baseUrl: url,
    format: "binary",
    deadline: 10_000,
    fetch: wrappedFetch as typeof globalThis.fetch,
  });
  const client = new SuiGrpcClient({ network: "mainnet", transport });

  try {
    const res = await client.ledgerService.getServiceInfo({}).response;
    console.log(`  result: OK (checkpoint: ${res.checkpointHeight})`);
    return true;
  } catch (e: any) {
    console.log(`  result: FAIL — ${e.message}`);
    return false;
  }
}

async function testViaRegions(url: string, regions: string[]) {
  console.log(`\n--- Edge tests via Fly.io regions ---\n`);

  const crypto = await import("crypto");
  const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);

  for (const region of regions) {
    process.stdout.write(`  ${region.toUpperCase().padEnd(4)}: `);
    try {
      const res = await fetch(`${HAYABUSA_API}/api/debug-backends?network=mainnet`, {
        headers: { "fly-force-region": region },
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json()) as any;
      const colo = data.colo ?? "?";
      const backend = data.results?.find((r: any) => r.backend?.startsWith(hash.slice(0, 8)) || r.url === url);

      if (!backend) {
        console.log(`not in config (CF colo: ${colo})`);
        continue;
      }

      if (backend.error) {
        console.log(`ERROR — ${backend.error} (CF colo: ${colo})`);
        continue;
      }

      const isGrpcWeb = backend.contentType?.includes("grpc-web");
      const hasTrailer = backend.hasTrailerFrame;
      const compressed = backend.bodyFirst8?.startsWith("01");
      const encoding = backend.headers?.["grpc-encoding"];

      const issues: string[] = [];
      if (!isGrpcWeb) issues.push(`native gRPC (${backend.contentType})`);
      if (!hasTrailer) issues.push("no trailer frame");
      if (compressed) issues.push(`compressed (${encoding ?? "unknown"})`);

      if (issues.length === 0) {
        console.log(`OK — ${backend.bodyLength}B, ${backend.latencyMs}ms (CF colo: ${colo})`);
      } else {
        console.log(`ISSUES — ${issues.join(", ")} — ${backend.bodyLength}B, ${backend.latencyMs}ms (CF colo: ${colo})`);
      }
    } catch (e: any) {
      console.log(`FAIL — ${e.message}`);
    }
  }
}

const { url, regions } = parseArgs();
const directOk = await testDirect(url);
await testViaRegions(url, regions);

console.log(`\n--- Summary ---\n`);
console.log(`  Direct:   ${directOk ? "PASS" : "FAIL"}`);
console.log(`  Backend:  ${url}`);
console.log(`  Regions:  ${regions.join(", ")}`);
console.log();
