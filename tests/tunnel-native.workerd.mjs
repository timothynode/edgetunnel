import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
const runtime = await import(process.env.EDGETUNNEL_MINIFLARE_MODULE || 'miniflare');
const source = fs.readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
const uuid = '12345678-1234-4abc-8def-123456789abc';
const sockets = new Set();
let accepted = 0;
const server = net.createServer(socket => {
	accepted++;
	sockets.add(socket);
	socket.on('close', () => sockets.delete(socket));
	socket.on('data', data => socket.write(data));
	socket.on('error', () => {});
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const runtimeOptions = {
	modules: true, cf: false, compatibilityDate: '2025-11-04',
	bindings: { UUID: uuid }, script: source,
};
const mf = new runtime.Miniflare(runtime.convertV4MiniflareOptions
	? runtime.convertV4MiniflareOptions(runtimeOptions) : runtimeOptions);
function header(identity) {
	return Buffer.concat([
		Buffer.from([0]), Buffer.from(identity.replaceAll('-', ''), 'hex'),
		Buffer.from([0, 1, port >> 8, port & 255, 1, 127, 0, 0, 1]),
	]);
}
async function within(promise) {
	let timeout;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timeout = setTimeout(() => reject(new Error('native tunnel test timed out')), 12000);
		})]);
	} finally { clearTimeout(timeout); }
}
let ws;
try {
	// Invalid credentials must close before any real TCP connection is opened.
	const invalid = await mf.dispatchFetch('https://worker.example/', { headers: { Upgrade: 'websocket' } });
	assert.equal(invalid.status, 101);
	const badWS = invalid.webSocket;
	const rejected = new Promise((resolve, reject) => {
		badWS.addEventListener('close', resolve);
		badWS.addEventListener('message', () => reject(new Error('invalid UUID received data')));
		badWS.addEventListener('error', reject);
	});
	badWS.accept();
	badWS.send(header('22345678-1234-4abc-8def-123456789abc'));
	await within(rejected);
	assert.equal(accepted, 0, 'invalid UUID must never reach TCP');

	// Exercise the actual Worker entry point, VLESS parser, native TCP dial and return path.
	const payloads = [Buffer.alloc(2000, 17), Buffer.alloc(65536, 38), Buffer.alloc(131714, 77)];
	const expected = Buffer.concat([Buffer.from([0, 0]), ...payloads]);
	const response = await mf.dispatchFetch('https://worker.example/', { headers: { Upgrade: 'websocket' } });
	assert.equal(response.status, 101);
	ws = response.webSocket;
	const received = [];
	let count = 0;
	const done = new Promise((resolve, reject) => {
		ws.addEventListener('message', event => {
			const chunk = Buffer.from(event.data);
			received.push(chunk);
			count += chunk.length;
			if (count >= expected.length) resolve();
		});
		ws.addEventListener('error', reject);
		ws.addEventListener('close', () => {
			if (count < expected.length) reject(new Error(`closed early at ${count} bytes`));
		});
	});
	ws.accept();
	ws.send(Buffer.concat([header(uuid), payloads[0]]));
	ws.send(payloads[1]);
	ws.send(payloads[2]);
	await within(done);
	assert.deepEqual(Buffer.concat(received), expected);
	console.log(JSON.stringify({
		runtime: 'native workerd', entry: 'actual Worker WebSocket handler',
		invalidUUIDConnections: 0, payloadBytes: expected.length - 2, byteExact: true,
	}));
} finally {
	try { ws?.close(); } catch {}
	for (const socket of sockets) socket.destroy();
	await mf.dispose();
	await new Promise(resolve => server.close(resolve));
}
