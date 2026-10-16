// Temporary production execution probe; no business modules or data access.
export default {
 fetch(request) {
  if (request.method === 'GET' && new URL(request.url).pathname === '/__edgetunnel_entry_probe_20261016') {
   return new Response('minimal-entry-ok', {headers:{'Content-Type':'text/plain;charset=utf-8','Cache-Control':'no-store','X-EdgeTunnel-Bootstrap':'minimal-only'}});
  }
  return new Response('Service temporarily unavailable', {status:503,headers:{'Cache-Control':'no-store'}});
 }
};
