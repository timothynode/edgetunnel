#!/usr/bin/env node

import { randomInt } from 'node:crypto';
import tls from 'node:tls';

const CIDR_URLS = {
	cu: 'https://raw.githubusercontent.com/cmliu/cmliu/main/CF-CIDR/cu.txt',
	ct: 'https://raw.githubusercontent.com/cmliu/cmliu/main/CF-CIDR/ct.txt',
	cmcc: 'https://raw.githubusercontent.com/cmliu/cmliu/main/CF-CIDR/cmcc.txt',
	cf: 'https://raw.githubusercontent.com/cmliu/cmliu/main/CF-CIDR.txt',
};

function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (!arg.startsWith('--')) continue;
		const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
		args[rawKey] = inlineValue ?? argv[++index];
	}
	const hostInput = String(args.host || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
	if (!hostInput) throw new Error('缺少 --host，例如 --host worker.example.com');
	const isp = String(args.isp || 'cu').toLowerCase();
	if (!CIDR_URLS[isp]) throw new Error('--isp 仅支持 cu、ct、cmcc、cf');
	return {
		host: hostInput,
		isp,
		addresses: String(args.addresses || '').split(',').map(value => value.trim()).filter(Boolean),
		port: boundedInt(args.port, 443, 1, 65535),
		count: boundedInt(args.count, 64, 1, 1000),
		top: boundedInt(args.top, 8, 1, 99),
		rounds: boundedInt(args.rounds, 3, 1, 10),
		concurrency: boundedInt(args.concurrency, 16, 1, 100),
		timeout: boundedInt(args.timeout, 3000, 200, 30000),
		path: String(args.path || '/'),
	};
}

function boundedInt(value, fallback, min, max) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function ipv4ToInt(ip) {
	return ip.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function intToIpv4(value) {
	return [value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255].join('.');
}

function randomIpFromCidr(cidr) {
	const [baseIp, rawPrefix] = cidr.split('/');
	const prefix = Number(rawPrefix);
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(baseIp) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`无效 CIDR: ${cidr}`);
	const hostBits = 32 - prefix;
	const size = 2 ** hostBits;
	const mask = prefix === 0 ? 0 : (0xffffffff << hostBits) >>> 0;
	return intToIpv4(((ipv4ToInt(baseIp) & mask) + randomInt(size)) >>> 0);
}

function percentile(values, ratio) {
	if (!values.length) return Infinity;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function probeTls({ ip, host, port, path, timeout }) {
	return new Promise((resolve) => {
		const startedAt = performance.now();
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		const socket = tls.connect({ host: ip, port, servername: host, rejectUnauthorized: true });
		socket.setTimeout(timeout, () => finish({ ok: false, error: 'timeout' }));
		socket.once('secureConnect', () => {
			const tlsMs = performance.now() - startedAt;
			socket.write(`GET ${path.startsWith('/') ? path : `/${path}`} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: edgetunnel-local-optimizer/1\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
			socket.once('data', () => finish({ ok: true, tlsMs, ttfbMs: performance.now() - startedAt }));
	});
		socket.once('error', error => finish({ ok: false, error: error.code || error.message }));
	});
}

async function runLimited(items, concurrency, worker) {
	const results = new Array(items.length);
	let cursor = 0;
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await worker(items[index]);
		}
	}));
	return results;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const candidates = new Set();
	if (options.addresses.length) {
		for (const ip of options.addresses) {
			if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`无效 IPv4 地址: ${ip}`);
			candidates.add(ip);
		}
	} else {
		const response = await fetch(CIDR_URLS[options.isp]);
		if (!response.ok) throw new Error(`CIDR 下载失败: HTTP ${response.status}`);
		const cidrs = (await response.text()).split(/[\s,]+/).map(value => value.trim()).filter(Boolean);
		if (!cidrs.length) throw new Error('CIDR 列表为空');
		while (candidates.size < options.count) candidates.add(randomIpFromCidr(cidrs[randomInt(cidrs.length)]));
	}
	const jobs = [...candidates].flatMap(ip => Array.from({ length: options.rounds }, () => ip));
	console.error(`testing ${candidates.size} ${options.isp} candidates against ${options.host}:${options.port}, ${options.rounds} rounds`);
	const probeResults = await runLimited(jobs, options.concurrency, ip => probeTls({ ip, ...options }));

	const grouped = new Map([...candidates].map(ip => [ip, []]));
	jobs.forEach((ip, index) => grouped.get(ip).push(probeResults[index]));
	const minimumSuccesses = Math.ceil(options.rounds * 0.67);
	const ranked = [...grouped].map(([ip, attempts]) => {
		const successes = attempts.filter(result => result.ok);
		const ttfbValues = successes.map(result => result.ttfbMs);
		return {
			ip,
			successes: successes.length,
			median: percentile(ttfbValues, 0.5),
			p95: percentile(ttfbValues, 0.95),
		};
	}).filter(result => result.successes >= minimumSuccesses)
		.map(result => ({ ...result, score: result.median + Math.max(0, result.p95 - result.median) * 0.5 }))
		.sort((left, right) => left.score - right.score || left.median - right.median)
		.slice(0, options.top);

	if (!ranked.length) throw new Error('没有候选地址通过成功率门槛');
	ranked.forEach((result, index) => {
		const remark = `${options.isp.toUpperCase()}实测${index + 1} median=${Math.round(result.median)}ms p95=${Math.round(result.p95)}ms ok=${result.successes}/${options.rounds}`;
		console.log(`${result.ip}:${options.port}#${remark}`);
	});
}

main().catch((error) => {
	console.error(error.message || error);
	process.exitCode = 1;
});
