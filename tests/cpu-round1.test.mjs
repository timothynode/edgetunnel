import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const workerPath = new URL('../_worker.js', import.meta.url);
const source = readFileSync(workerPath, 'utf8');
const explicitUUID = '12345678-1234-4ABC-8DEF-123456789ABC';
const deferred = () => {
	let resolve, reject;
	const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
	return { promise, resolve, reject };
};
function legacyID(password, key) {
	const first = createHash('md5').update(password + key).digest('hex');
	const hash = createHash('md5').update(first.slice(7, 27)).digest('hex');
	return [hash.slice(0, 8), hash.slice(8, 12), '4' + hash.slice(13, 16), '8' + hash.slice(17, 20), hash.slice(20)].join('-');
}
function loadWorker(options = {}) {
	const timers = new Map();
	let timerID = options.firstTimerID ?? 1, digestCalls = 0, cleared = 0;
	const digest = async (algorithm, bytes) => {
		digestCalls++;
		if (options.beforeDigest) await options.beforeDigest(digestCalls);
		// Node WebCrypto lacks MD5; use the same digest through node:crypto.
		const result = createHash(algorithm.toLowerCase().replace('-', '')).update(Buffer.from(bytes)).digest();
		return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
	};
	const context = vm.createContext({
		AbortController, Headers, Request, Response, TextDecoder, TextEncoder, URL, URLSearchParams,
		atob, btoa, console, queueMicrotask, performance,
		crypto: { subtle: { digest }, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
		WebSocket: { OPEN: 1, CLOSING: 2, CLOSED: 3 },
		setTimeout(callback, delay) { const id = timerID++; timers.set(id, { callback, delay }); return id; },
		clearTimeout(id) { cleared++; timers.delete(id); },
		fetch() { throw new Error('Network calls are forbidden in these tests'); },
	});
	new vm.Script(source.replace('export default {', 'const __worker_default__ = {')).runInContext(context);
	const start = source.indexOf('\tasync function 等待连接建立(');
	const end = source.indexOf('\n\tasync function 打开TCP连接(', start);
	assert.ok(start >= 0 && end > start);
	new vm.Script(`const 连接超时毫秒=1000; ${source.slice(start, end)}`).runInContext(context);
	return {
		context, timers,
		id: context['获取用户ID'], sender: context['创建下行Grain发送器'], wait: context['等待连接建立'],
		get digestCalls() { return digestCalls; }, get cleared() { return cleared; },
		fetch(request, env) { return vm.runInContext('__worker_default__', context).fetch(request, env, {}); },
	};
}

test('explicit UUID preserves normalization and skips all identity hashing', async () => {
	const w = loadWorker({ beforeDigest() { throw new Error('must not hash'); } });
	assert.equal(await w.id(explicitUUID, 'password', 'key'), explicitUUID.toLowerCase());
	assert.equal(w.digestCalls, 0);
});

test('derived identity remains byte-for-byte compatible and warm calls reuse its result', async () => {
	const w = loadWorker();
	for (const uuid of [undefined, 'invalid', '12345678-1234-1abc-8def-123456789abc']) {
		assert.equal(await w.id(uuid, '密码', 'key'), legacyID('密码', 'key'));
	}
	for (let i = 0; i < 100; i++) assert.equal(await w.id(null, '密码', 'key'), legacyID('密码', 'key'));
	assert.equal(w.digestCalls, 2);
});

test('cold requests derive independently and then reuse only completed identities', async () => {
	const gate = deferred();
	const w = loadWorker({ beforeDigest: () => gate.promise });
	const requests = Array.from({ length: 32 }, () => w.id(null, 'password', 'key'));
	assert.equal(w.digestCalls, 32);
	gate.resolve();
	assert.deepEqual(await Promise.all(requests), Array(32).fill(legacyID('password', 'key')));
	assert.equal(w.digestCalls, 64);
	assert.equal(await w.id(null, 'password', 'key'), legacyID('password', 'key'));
	assert.equal(w.digestCalls, 64);
});

test('a hung or cancelled cold request cannot block later requests with the same credentials', async () => {
	const orphan = deferred();
	const w = loadWorker({ beforeDigest(call) { if (call === 1) return orphan.promise; } });
	const cancelled = assert.rejects(w.id(null, 'password', 'key'), { message: 'request cancelled' });
	let deadline;
	try {
		assert.equal(await Promise.race([
			w.id(null, 'password', 'key'),
			new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('later request blocked by orphan')), 200); }),
		]), legacyID('password', 'key'));
	} finally { clearTimeout(deadline); orphan.reject(new Error('request cancelled')); }
	await cancelled;
	const calls = w.digestCalls;
	assert.equal(await w.id(null, 'password', 'key'), legacyID('password', 'key'));
	assert.equal(w.digestCalls, calls, 'late failure must preserve a completed cache value');
});

test('password and key changes invalidate the bounded identity cache', async () => {
	const w = loadWorker();
	for (const [password, key] of [['p1', 'k1'], ['p2', 'k1'], ['p2', 'k2'], ['p1', 'k1']]) {
		assert.equal(await w.id(null, password, key), legacyID(password, key));
	}
	assert.equal(w.digestCalls, 8);
});

test('failed derivation does not poison subsequent requests', async () => {
	const w = loadWorker({ beforeDigest(call) { if (call === 1) throw new Error('digest failed'); } });
	await assert.rejects(w.id(null, 'p', 'k'), { message: 'digest failed' });
	assert.equal(await w.id(null, 'p', 'k'), legacyID('p', 'k'));
	assert.equal(w.digestCalls, 3);
});

test('an older failing configuration cannot evict a newer successful cache entry', async () => {
	const old = deferred();
	const w = loadWorker({ beforeDigest(call) { if (call === 1) return old.promise; } });
	const pending = assert.rejects(w.id(null, 'old', 'key'), { message: 'old failed' });
	assert.equal(await w.id(null, 'new', 'key'), legacyID('new', 'key'));
	old.reject(new Error('old failed'));
	await pending;
	assert.equal(await w.id(null, 'new', 'key'), legacyID('new', 'key'));
	assert.equal(w.digestCalls, 3);
});

test('fetch uses the optimized identity path and keeps version authentication intact', async () => {
	const w = loadWorker();
	const request = uuid => ({
		url: `https://worker.example/version?uuid=${uuid}`, headers: new Headers(), method: 'GET',
		cf: { colo: 'HKG', country: 'CN', asn: 17622 },
	});
	const response = await w.fetch(request(explicitUUID), { UUID: explicitUUID });
	assert.equal(response.status, 200);
	assert.ok((await response.json()).Version > 0);
	assert.equal(w.digestCalls, 0);
	const derived = legacyID('p', 'k');
	for (let i = 0; i < 3; i++) assert.equal((await w.fetch(request(derived), { ADMIN: 'p', KEY: 'k' })).status, 200);
	assert.equal(w.digestCalls, 2);
});

test('downstream keeps headers, byte order and payloads across partial, full and large chunks', async () => {
	const w = loadWorker();
	const sent = [], expected = [Buffer.from([1, 0])];
	const sender = w.sender({ readyState: 1, send(chunk) { sent.push(chunk); } }, new Uint8Array([1, 0]));
	for (const [i, size] of [0, 1, 511, 512, 16000, 16384, 32768, 65536].entries()) {
		const chunk = new Uint8Array(size).fill(i);
		expected.push(Buffer.from(chunk));
		await sender.发送(chunk);
	}
	await sender.flush();
	assert.deepEqual(Buffer.concat(sent.map(x => Buffer.from(x))), Buffer.concat(expected));
	assert.equal(w.timers.size, 0);
});

test('handed-off downstream buffer remains unchanged while send is pending', async () => {
	const w = loadWorker();
	const gate = deferred(), sent = [];
	const sender = w.sender({ readyState: 1, send(chunk) { sent.push(chunk); return sent.length === 1 ? gate.promise : undefined; } });
	await sender.发送(new Uint8Array(1024).fill(17));
	const first = sender.flush();
	assert.equal(sent.length, 1);
	await sender.发送(new Uint8Array(2048).fill(29));
	const second = sender.flush();
	assert.deepEqual(Buffer.from(sent[0]), Buffer.alloc(1024, 17));
	gate.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(Buffer.from(sent[0]), Buffer.alloc(1024, 17));
	assert.deepEqual(Buffer.from(sent[1]), Buffer.alloc(2048, 29));
	assert.notEqual(sent[0].buffer, sent[1].buffer);
});

test('downstream propagates send failures and rejects closed sockets', async () => {
	const w = loadWorker();
	const broken = w.sender({ readyState: 1, send() { throw new Error('send failed'); } });
	await broken.发送(new Uint8Array([1]));
	await assert.rejects(broken.flush(), { message: 'send failed' });
	const closed = w.sender({ readyState: 3, send() { assert.fail('closed send'); } });
	await closed.发送(new Uint8Array([1]));
	await assert.rejects(closed.flush(), /ws.readyState is not open/);
});

test('successful connection clears its deadline, including timer ID zero', async () => {
	const w = loadWorker({ firstTimerID: 0 });
	await w.wait({ opened: Promise.resolve() });
	assert.equal(w.timers.size, 0);
	assert.equal(w.cleared, 1);
});

test('failed connection clears its deadline and preserves the connection error', async () => {
	const w = loadWorker();
	await assert.rejects(w.wait({ opened: Promise.reject(new Error('dial failed')) }), { message: 'dial failed' });
	assert.equal(w.timers.size, 0);
});

test('deadline still terminates a stalled connection and cleans up', async () => {
	const w = loadWorker(), opened = deferred();
	const pending = w.wait({ opened: opened.promise }, 1234);
	const rejected = assert.rejects(pending, { message: '连接超时' });
	const timer = [...w.timers.values()][0];
	assert.equal(timer.delay, 1234);
	timer.callback();
	await rejected;
	assert.equal(w.timers.size, 0);
	opened.resolve();
});
