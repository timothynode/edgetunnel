// Temporary incident diagnostics. Never print credentials, bindings, or unfiltered request logs.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
if (process.env.WORKERS_CI !== '1') {
 console.log('[diagnostic] skipped outside Cloudflare Builds');
 process.exit(0);
}
const account = '6e7adafd161e8e630908d2d70b3275a4';
const token = process.env.CLOUDFLARE_API_TOKEN;
const probe = `edgetunnel-${Date.now()}`;
const emit = data => console.log('[production-diagnostic] '+JSON.stringify(data));
const safe = value => {
 let text=String(value??'');
 if(token)text=text.replaceAll(token,'[redacted]');
 return text.slice(0,500);
};
if(token) {
 for(const endpoint of [`workers/services/edgetunnel`, `workers/services/edgetunnel/environments/production`, `workers/scripts/edgetunnel/settings`]) {
  try {
   const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${endpoint}`, {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
   const data=await response.json(), result=data.result||{};
   const script=result.script||{}, environment=result.default_environment||{};
   emit({check:'control-plane',endpoint,status:response.status,success:data.success,errorCodes:data.errors?.map(e=>e.code),id:result.id,defaultEnvironment:environment.environment||environment.name,script:{id:script.id,tag:script.tag,modifiedOn:script.modified_on},compatibilityDate:result.compatibility_date,compatibilityFlags:result.compatibility_flags});
  }catch(error){emit({check:'control-plane',endpoint,errorType:error.name});}
 }
} else emit({check:'build-auth',tokenAvailable:false});
const tail=spawn(process.execPath,[fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url)),'tail','edgetunnel','--format','json','--header',`X-EdgeTunnel-Probe:${probe}`],{env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';
tail.stdout.on('data',chunk=>{if(stdout.length<100000)stdout+=chunk;});
tail.stderr.on('data',chunk=>{if(stderr.length<100000)stderr+=chunk;});
try {
 await delay(5000);
 for(const path of ['/__edgetunnel_entry_probe_20261016','/__edgetunnel_route_probe_only/entry']) {
  try {
   const response=await fetch('https://g5gx9c.nocal.host'+path,{headers:{'User-Agent':'Mozilla/5.0 EdgeTunnel Release Check','X-EdgeTunnel-Probe':probe},signal:AbortSignal.timeout(10000)});
   const body=await response.text();
   emit({check:'cloud-build-http',path,status:response.status,bootstrap:response.headers.get('X-EdgeTunnel-Bootstrap'),handler:response.headers.get('X-EdgeTunnel-Error'),ray:response.headers.get('cf-ray'),entryOK:body==='entry-ok'});
  }catch(error){emit({check:'cloud-build-http',path,errorType:error.name});}
 }
 await delay(4000);
}finally{
 tail.kill('SIGTERM');
 await Promise.race([new Promise(resolve=>tail.once('exit',resolve)),delay(2000)]);
 if(tail.exitCode===null)tail.kill('SIGKILL');
}
// Extract complete JSON events, discarding banners and every request/log payload.
let depth=0,start=-1,inString=false,escape=false,events=0;
for(let i=0;i<stdout.length;i++){
 const char=stdout[i];
 if(inString){if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')inString=false;continue;}
 if(char==='"'&&depth>0){inString=true;continue;}
 if(char==='{'){if(depth++===0)start=i;}
 if(char==='}'&&depth>0&&--depth===0){
  try{const event=JSON.parse(stdout.slice(start,i+1));if(event.outcome){events++;emit({check:'filtered-tail',outcome:event.outcome,cpuTime:event.cpuTime,wallTime:event.wallTime,exceptions:event.exceptions?.map(e=>({name:safe(e.name),message:safe(e.message)}))});}}catch{}
 }
}
emit({check:'tail-summary',events,exitCode:tail.exitCode,authenticationError:/not logged in|authentication error|requires.*api.token/i.test(stdout+stderr),websocketError:/websocket.*error|unexpected server response/i.test(stdout+stderr)});
