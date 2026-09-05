import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const workerPath = new URL('../_worker.js', import.meta.url);
const workerSource = readFileSync(workerPath, 'utf8').replace('export default {', 'const __worker_default__ = {');
const fetchedUrls = [];
const deterministicMath = Object.create(Math);
let randomCursor = 0;
deterministicMath.random = () => ((randomCursor++ % 97) + 1) / 100;
const context = vm.createContext({
	AbortController,
	Headers,
	Math: deterministicMath,
	Request,
	Response,
	TextDecoder,
	TextEncoder,
	URL,
	URLSearchParams,
	atob,
	btoa,
	clearTimeout,
	console,
	crypto: webcrypto,
	fetch: async (input) => {
		const url = String(input);
		fetchedUrls.push(url);
		if (url.includes('raw.githubusercontent.com')) return new Response('198.51.100.0/24');
		if (url.startsWith('https://generator.example/sub?')) {
			const node = 'vless://00000000-0000-4000-8000-000000000000@198.51.100.1:443?security=tls&sni=example.com#test';
			return new Response(btoa(node));
		}
		throw new Error(`unexpected fetch: ${url}`);
	},
	performance,
	setTimeout,
});
new vm.Script(workerSource, { filename: workerPath.pathname }).runInContext(context);

const 识别运营商 = context['识别运营商'];
const 获取请求运营商 = context['获取请求运营商'];
const 读取自定义优选IP = context['读取自定义优选IP'];
const 获取优选订阅生成器数据 = context['获取优选订阅生成器数据'];

function makeRequest(isp, url = 'https://worker.example/sub') {
	return { url, cf: isp };
}

function makeKV(entries) {
	const values = new Map(Object.entries(entries));
	return {
		async get(key) { return values.get(key) ?? null; },
		async put(key, value) { values.set(key, value); },
	};
}

function makeConfig(overrides = {}) {
	return {
		优选订阅生成: {
			本地IP库: {
				指定端口: 443,
				多运营商: {
					启用: true,
					首选数量: 3,
					通用池数量: 1,
					其他池数量: 1,
					旧池数量: 1,
					...overrides,
				},
			},
		},
	};
}

const pools = {
	'ADD.txt': '192.0.2.1:443#legacy-1\n192.0.2.2:443#legacy-2',
	'ADD-cu.txt': '10.0.0.1:443#cu-1\n10.0.0.2:443#cu-2\n10.0.0.3:443#cu-3\n10.0.0.4:443#cu-4',
	'ADD-ct.txt': '10.1.0.1:443#ct-1\n10.1.0.2:443#ct-2\n10.1.0.3:443#ct-3\n10.1.0.4:443#ct-4',
	'ADD-cmcc.txt': '10.2.0.1:443#cmcc-1',
	'ADD-cf.txt': '10.3.0.1:443#cf-1\n10.3.0.2:443#cf-2',
};

assert.equal(识别运营商(makeRequest({ country: 'CN', asn: 17622, asOrganization: '' })), 'cu');
assert.equal(获取请求运营商(makeRequest({ country: 'CN', asn: 17622 }, 'https://worker.example/sub?cnIspCode=ct')), 'ct');
assert.equal(获取请求运营商(makeRequest({ country: 'CN', asn: 17622 }, 'https://worker.example/admin/ADD.txt?isp=cmcc&effective=1')), 'cmcc');

const cuList = await 读取自定义优选IP({ KV: makeKV(pools) }, makeRequest({ country: 'CN', asn: 17622 }), makeConfig());
assert.deepEqual(Array.from(cuList), [
	'10.0.0.1:443#cu-1',
	'10.0.0.2:443#cu-2',
	'10.0.0.3:443#cu-3',
	'10.3.0.1:443#cf-1',
	'10.1.0.1:443#ct-1',
	'10.2.0.1:443#cmcc-1',
	'192.0.2.1:443#legacy-1',
]);

const ctList = await 读取自定义优选IP({ KV: makeKV(pools) }, makeRequest({ country: 'CN', asn: 4134 }), makeConfig());
assert.deepEqual(Array.from(ctList), [
	'10.1.0.1:443#ct-1',
	'10.1.0.2:443#ct-2',
	'10.1.0.3:443#ct-3',
	'10.3.0.1:443#cf-1',
	'10.0.0.1:443#cu-1',
	'10.2.0.1:443#cmcc-1',
	'192.0.2.1:443#legacy-1',
]);

const legacyOnly = await 读取自定义优选IP(
	{ KV: makeKV(pools) },
	makeRequest({ country: 'CN', asn: 17622 }),
	makeConfig({ 启用: false }),
);
assert.deepEqual(Array.from(legacyOnly), ['192.0.2.1:443#legacy-1', '192.0.2.2:443#legacy-2']);

const backwardCompatible = await 读取自定义优选IP(
	{ KV: makeKV({ 'ADD.txt': pools['ADD.txt'] }) },
	makeRequest({ country: 'CN', asn: 17622 }),
	makeConfig(),
);
assert.deepEqual(Array.from(backwardCompatible), ['192.0.2.1:443#legacy-1', '192.0.2.2:443#legacy-2']);

const missingCtPool = await 读取自定义优选IP(
	{ KV: makeKV({ 'ADD.txt': pools['ADD.txt'], 'ADD-cu.txt': pools['ADD-cu.txt'] }) },
	makeRequest({ country: 'CN', asn: 17622 }, 'https://worker.example/admin/ADD.txt?isp=ct&effective=1'),
	makeConfig(),
);
assert.equal(missingCtPool.length, 5);
assert.match(missingCtPool[0], /^198\.51\.100\.\d{1,3}:443#CF电信优选1$/);
assert.equal(missingCtPool[3], '10.0.0.1:443#cu-1');
assert.equal(missingCtPool[4], '192.0.2.1:443#legacy-1');

const isolatedDefaultCtPool = await 读取自定义优选IP(
	{ KV: makeKV({ 'ADD.txt': pools['ADD.txt'], 'ADD-cu.txt': pools['ADD-cu.txt'] }) },
	makeRequest({ country: 'CN', asn: 17622 }, 'https://worker.example/admin/ADD.txt?isp=ct&effective=1'),
	{ 优选订阅生成: { 本地IP库: { 指定端口: 443, 多运营商: { 启用: true } } } },
);
assert.equal(isolatedDefaultCtPool.length, 10);
assert.equal(isolatedDefaultCtPool.some(item => item.includes('#cu-')), false);
assert.equal(isolatedDefaultCtPool.at(-2), '192.0.2.1:443#legacy-1');
assert.equal(isolatedDefaultCtPool.at(-1), '192.0.2.2:443#legacy-2');

await 获取优选订阅生成器数据('sub://generator.example/path?cnIspCode=ct#generator');
const generatorUrl = new URL(fetchedUrls.find(url => url.startsWith('https://generator.example/sub?')));
assert.equal(generatorUrl.searchParams.get('cnIspCode'), 'ct');
assert.equal(generatorUrl.searchParams.get('host'), 'example.com');

console.log('multi-ISP pool tests passed');
