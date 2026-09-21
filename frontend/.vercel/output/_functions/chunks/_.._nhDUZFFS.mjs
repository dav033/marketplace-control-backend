import { t as __exportAll } from "./rolldown-runtime_D7D4PA-g.mjs";
import { n as SERVICE_TOKEN_HEADER } from "./contract_B7tfa3pq.mjs";
//#region src/pages/api/[...path].ts
var ____path__exports = /* @__PURE__ */ __exportAll({
	DELETE: () => DELETE,
	GET: () => GET,
	HEAD: () => HEAD,
	PATCH: () => PATCH,
	POST: () => POST,
	PUT: () => PUT
});
var env = (name) => Object.assign({
	"ASSETS_PREFIX": void 0,
	"BASE_URL": "/",
	"DEV": false,
	"MODE": "production",
	"PROD": true,
	"SITE": void 0,
	"SSR": true
}, {
	BACKEND_SERVICE_TOKEN: "token-local-de-prueba-32-caracteres",
	BACKEND_URL: "http://127.0.0.1:4321",
	OS: "Windows_NT",
	_: "C:/Program Files/nodejs/node.exe"
})?.[name] ?? process.env[name];
var HOP_BY_HOP = /* @__PURE__ */ new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"proxy-authorization",
	"proxy-authenticate",
	"te",
	"trailer",
	"host",
	"content-length"
]);
function backendBase() {
	const configured = env("BACKEND_URL");
	return configured ? configured.replace(/\/$/, "") : void 0;
}
var proxy = async ({ request, params, url }) => {
	const base = backendBase();
	if (!base) return new Response(JSON.stringify({
		ok: false,
		error: "BACKEND_URL_NOT_CONFIGURED"
	}), {
		status: 503,
		headers: { "content-type": "application/json; charset=utf-8" }
	});
	const destino = `${base}/api/${params.path ?? ""}${url.search}`;
	const cabeceras = new Headers();
	request.headers.forEach((valor, nombre) => {
		if (!HOP_BY_HOP.has(nombre.toLowerCase())) cabeceras.set(nombre, valor);
	});
	const token = env("BACKEND_SERVICE_TOKEN");
	if (token) cabeceras.set(SERVICE_TOKEN_HEADER, token);
	const tieneCuerpo = request.method !== "GET" && request.method !== "HEAD";
	let respuesta;
	try {
		respuesta = await fetch(destino, {
			method: request.method,
			headers: cabeceras,
			body: tieneCuerpo ? await request.arrayBuffer() : void 0,
			redirect: "manual"
		});
	} catch (error) {
		console.error("proxy al backend falló", destino, error instanceof Error ? error.message : error);
		return new Response(JSON.stringify({
			ok: false,
			error: "BACKEND_UNREACHABLE"
		}), {
			status: 502,
			headers: { "content-type": "application/json; charset=utf-8" }
		});
	}
	const salida = new Headers();
	respuesta.headers.forEach((valor, nombre) => {
		if (!HOP_BY_HOP.has(nombre.toLowerCase())) salida.set(nombre, valor);
	});
	return new Response(respuesta.body, {
		status: respuesta.status,
		headers: salida
	});
};
var GET = proxy;
var POST = proxy;
var PUT = proxy;
var PATCH = proxy;
var DELETE = proxy;
var HEAD = proxy;
//#endregion
//#region \0virtual:astro:page:src/pages/api/[...path]@_@ts
var page = () => ____path__exports;
//#endregion
export { page };
