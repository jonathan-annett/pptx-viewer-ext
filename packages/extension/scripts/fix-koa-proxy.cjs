// Make @vscode/test-web's Koa app honour X-Forwarded-Proto when behind a
// reverse proxy (Caddy/nginx/etc) terminating TLS. Without this, ctx.protocol
// is always "http" and VS Code Web emits mixed-content asset URLs.
//
// Koa's `app.proxy` flag is set in the constructor (default false), so we
// wrap the exported class to force proxy=true.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
	const m = origLoad.apply(this, [request, parent, ...rest]);
	if (request === 'koa' && typeof m === 'function' && !m.__pptxProxyPatched) {
		const Orig = m;
		function PatchedKoa(opts) {
			return Reflect.construct(
				Orig,
				[{ proxy: true, ...(opts || {}) }],
				new.target || PatchedKoa,
			);
		}
		Object.setPrototypeOf(PatchedKoa.prototype, Orig.prototype);
		Object.setPrototypeOf(PatchedKoa, Orig);
		PatchedKoa.__pptxProxyPatched = true;
		return PatchedKoa;
	}
	return m;
};
