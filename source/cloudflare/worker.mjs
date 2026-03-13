/**
 * Cloudflare Worker for serving static assets
 * Uses the new Static Assets binding (replaces Pages)
 * https://developers.cloudflare.com/workers/static-assets/
 */

export default {
	 
	async fetch(request, env) {
		// Serve static assets via the ASSETS binding
		const response = await env.ASSETS.fetch(request);

		// Add COOP and COEP headers for SharedArrayBuffer support
		const newResponse = new Response(response.body, response);
		newResponse.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
		newResponse.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

		// Set cache control headers based on path
		const url = new URL(request.url);
		if (url.pathname === '/index.html') {
			newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
		} else if (url.pathname.startsWith('/libs/')) {
			newResponse.headers.set('Cache-Control', 'public, max-age=2592000, immutable');
		}

		return newResponse;
	},
};
