export {};

const BASE = 'http://localhost:8788';

// Empty gRPC-Web frame (5 bytes: 0x00 flag + 4 bytes zero length)
const EMPTY_FRAME = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]);

async function grpcPost(path: string, body: Uint8Array = EMPTY_FRAME) {
	const res = await fetch(`${BASE}${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/grpc-web+proto',
			accept: 'application/grpc-web+proto',
		},
		body,
	});
	return res;
}

console.log('=== Race test: 5x GetServiceInfo ===\n');

for (let i = 0; i < 5; i++) {
	const start = performance.now();
	const res = await grpcPost('/sui.rpc.v2.LedgerService/GetServiceInfo');
	const elapsed = (performance.now() - start).toFixed(1);
	const backend = res.headers.get('x-hayabusa-backend');
	const latency = res.headers.get('x-hayabusa-latency');
	console.log(`[${i + 1}] status=${res.status} backend=${backend} latency=${latency}ms (total ${elapsed}ms)`);
}

console.log('\n=== Latency endpoint ===\n');

const latencyRes = await fetch(`${BASE}/latency`);
const latencyData = await latencyRes.json();
console.log(JSON.stringify(latencyData, null, 2));
