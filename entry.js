// Keep production entry diagnostics independent of business-module initialization.
export default {
	async fetch(request, env, ctx) {
		const path = new URL(request.url).pathname;
		if (request.method === 'GET' && (path === '/__edgetunnel_entry_probe_20261016' || path === '/__edgetunnel_route_probe_only/entry')) {
			return new Response('entry-ok', { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain;charset=utf-8', 'X-EdgeTunnel-Bootstrap': 'lazy-v1' } });
		}
		try {
			const { default: worker } = await import('./_worker.js');
			return await worker.fetch(request, env, ctx);
		} catch (error) {
			console.error('[EdgeTunnel] module entry failed', error?.stack || String(error));
			return new Response('Service temporarily unavailable', {
				status: 503,
				headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain;charset=utf-8', 'X-EdgeTunnel-Error': 'module-entry' }
			});
		}
	}
};
