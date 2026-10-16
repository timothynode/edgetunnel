import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
// Install Miniflare locally or set EDGETUNNEL_MINIFLARE_MODULE to its absolute module path.
const { Miniflare } = await import(process.env.EDGETUNNEL_MINIFLARE_MODULE || 'miniflare');

const source=fs.readFileSync(new URL('../_worker.js', import.meta.url),'utf8');
const password='local-test-password', key='local-test-key';
const first=createHash('md5').update(password+key).digest('hex');
const hash=createHash('md5').update(first.slice(7,27)).digest('hex');
const derived=[hash.slice(0,8),hash.slice(8,12),'4'+hash.slice(13,16),'8'+hash.slice(17,20),hash.slice(20)].join('-');
const mf=new Miniflare({
	modules:true, compatibilityDate:'2025-11-04', cf:false,
	bindings:{ADMIN:password, KEY:key},
	script:source.replace('export default {','const originalWorker = {')+`
export default {
	async fetch(request,env,ctx) {
		if(new URL(request.url).pathname==='/__local_version') {
			const versionRequest={url:'https://worker.example/version?uuid='+new URL(request.url).searchParams.get('uuid'),headers:request.headers,method:'GET',cf:{colo:'HKG',country:'CN',asn:17622}};
			return originalWorker.fetch(versionRequest,env,ctx);
		}
		if(request.headers.get('Upgrade')!=='websocket')return new Response('websocket required',{status:400});
		const [client,server]=Object.values(new WebSocketPair());server.accept();
		const sender=创建下行Grain发送器(server,new Uint8Array([1,0]));
		ctx.waitUntil((async()=>{
			for(const [i,size]of [1,511,512,16000,16384,32768,65536].entries())await sender.发送(new Uint8Array(size).fill(i+1));
			await sender.flush();server.close(1000,'done');
		})());
		return new Response(null,{status:101,webSocket:client});
	}
};`,
});
try {
	for(let i=0;i<10;i++) {
		const response=await mf.dispatchFetch(`https://worker.example/__local_version?uuid=${derived}`);
		assert.equal(response.status,200);assert.ok((await response.json()).Version>0);
	}
	const response=await mf.dispatchFetch('https://worker.example/__local_ws',{headers:{Upgrade:'websocket'}});
	assert.equal(response.status,101);
	const ws=response.webSocket, received=[];
	const done=new Promise((resolve,reject)=>{
		ws.addEventListener('message',event=>received.push(Buffer.from(event.data)));
		ws.addEventListener('close',event=>event.code===1000?resolve():reject(new Error(`close ${event.code}`)));
		ws.addEventListener('error',reject);
	});
	ws.accept();
	await Promise.race([done,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('local websocket timeout')),10000);t.unref()})]);
	const expected=Buffer.concat([Buffer.from([1,0]),...[1,511,512,16000,16384,32768,65536].map((size,i)=>Buffer.alloc(size,i+1))]);
	assert.deepEqual(Buffer.concat(received),expected);
	console.log(JSON.stringify({runtime:'local workerd via Miniflare',versionRequests:10,websocketBytes:expected.length,websocketFrames:received.length,byteExact:true,network:'local only'},null,2));
} finally {await mf.dispose()}
