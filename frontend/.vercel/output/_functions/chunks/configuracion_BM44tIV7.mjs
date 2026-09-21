import { t as __exportAll } from "./rolldown-runtime_D7D4PA-g.mjs";
import { C as createAstro, d as renderTemplate, f as maybeRenderHead, i as renderComponent, m as addAttribute } from "./server_BgOX8cb3.mjs";
import { t as createComponent } from "./compiler_b2Y2_jyB.mjs";
import { t as renderScript } from "./script_h0d3jHTH.mjs";
import { t as $$AppLayout } from "./AppLayout_Cj4KBcmR.mjs";
import { n as fetchDashboard, t as fetchCampaignOverview } from "./api-client_DMiF7Ths.mjs";
//#region src/pages/configuracion.astro
var configuracion_exports = /* @__PURE__ */ __exportAll({
	default: () => $$Configuracion,
	file: () => $$file,
	url: () => $$url
});
createAstro("https://astro.build");
var $$Configuracion = createComponent(async ($$result, $$props, $$slots) => {
	const Astro = $$result.createAstro($$props, $$slots);
	Astro.self = $$Configuracion;
	const data = await fetchDashboard(Astro.url.origin);
	const { omnisendReady } = await fetchCampaignOverview(Astro.url.origin);
	return renderTemplate`${renderComponent($$result, "AppLayout", $$AppLayout, {
		"active": "",
		"title": "Configuración",
		"data-astro-cid-brm5xtdu": true
	}, { "default": ($$result) => renderTemplate`${maybeRenderHead($$result)}<div class="page" data-astro-cid-brm5xtdu><header class="page-header" data-astro-cid-brm5xtdu><div data-astro-cid-brm5xtdu><p class="eyebrow" data-astro-cid-brm5xtdu>Salud del sistema</p><h1 data-astro-cid-brm5xtdu>Configuración</h1><p class="page-intro" data-astro-cid-brm5xtdu>Puntos que deben quedar resueltos antes de habilitar campañas reales.</p></div></header><div class="content-grid" data-astro-cid-brm5xtdu><section class="panel detail-panel" data-astro-cid-brm5xtdu><div class="section-heading" data-astro-cid-brm5xtdu><h2 data-astro-cid-brm5xtdu>Conexiones</h2></div><ul class="settings-list" data-astro-cid-brm5xtdu><li data-astro-cid-brm5xtdu><span data-astro-cid-brm5xtdu><strong data-astro-cid-brm5xtdu>PostgreSQL</strong><small data-astro-cid-brm5xtdu>Base de datos de operación</small></span><b class="check-state" data-astro-cid-brm5xtdu>${data.connected ? "Conectado" : "Demo"}</b></li><li data-astro-cid-brm5xtdu><span data-astro-cid-brm5xtdu><strong data-astro-cid-brm5xtdu>Omnisend</strong><small data-astro-cid-brm5xtdu>Envío desde servidor, nunca navegador</small></span><b${addAttribute(omnisendReady ? "check-state" : "pending-state", "class")} data-astro-cid-brm5xtdu>${omnisendReady ? "Conectado" : "Pendiente"}</b></li><li data-astro-cid-brm5xtdu><span data-astro-cid-brm5xtdu><strong data-astro-cid-brm5xtdu>HTTPS</strong><small data-astro-cid-brm5xtdu>Requerido para campañas y formularios</small></span><b class="pending-state" data-astro-cid-brm5xtdu>Pendiente</b></li></ul></section><section class="panel detail-panel" data-astro-cid-brm5xtdu><div class="section-heading" data-astro-cid-brm5xtdu><h2 data-astro-cid-brm5xtdu>Protecciones</h2></div><ul class="settings-list" data-astro-cid-brm5xtdu><li data-astro-cid-brm5xtdu><span data-astro-cid-brm5xtdu><strong data-astro-cid-brm5xtdu>Consentimiento</strong><small data-astro-cid-brm5xtdu>Privacidad y marketing separados</small></span><b class="check-state" data-astro-cid-brm5xtdu>Activo</b></li><li data-astro-cid-brm5xtdu><span data-astro-cid-brm5xtdu><strong data-astro-cid-brm5xtdu>Tracking</strong><small data-astro-cid-brm5xtdu>Tokens opacos y hashes</small></span><b class="check-state" data-astro-cid-brm5xtdu>Activo</b></li><li data-astro-cid-brm5xtdu><span data-astro-cid-brm5xtdu><strong data-astro-cid-brm5xtdu>Backups</strong><small data-astro-cid-brm5xtdu>pg_dump programado a S3</small></span><b class="pending-state" data-astro-cid-brm5xtdu>Pendiente</b></li></ul></section><section class="panel detail-panel zona-riesgo" data-astro-cid-brm5xtdu><div class="section-heading" data-astro-cid-brm5xtdu><h2 data-astro-cid-brm5xtdu>Borrar los datos de operación</h2></div><p class="zona-texto" data-astro-cid-brm5xtdu>Elimina proveedores, contactos, campañas, envíos, clics y formularios recibidos. <strong data-astro-cid-brm5xtdu>No se puede deshacer.</strong> El historial de auditoría se conserva, para que quede constancia de qué se borró y cuándo.</p><div class="zona-conteo" id="reset-conteo" data-astro-cid-brm5xtdu>Consultando cuántos registros hay…</div><div class="zona-acciones" data-astro-cid-brm5xtdu><label class="zona-confirmar" data-astro-cid-brm5xtdu>Escribe <code data-astro-cid-brm5xtdu>BORRAR TODO</code> para habilitar<input class="form-input" id="reset-input" type="text" autocomplete="off" placeholder="BORRAR TODO" data-astro-cid-brm5xtdu></label><button class="danger-button" id="reset-boton" type="button" disabled data-astro-cid-brm5xtdu>Borrar todos los registros</button></div><p class="zona-estado" id="reset-estado" role="status" data-astro-cid-brm5xtdu></p></section></div></div>` })}${renderScript($$result, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/configuracion.astro?astro&type=script&index=0&lang.ts")}`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/configuracion.astro", void 0);
var $$file = "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/configuracion.astro";
var $$url = "/configuracion";
//#endregion
//#region \0virtual:astro:page:src/pages/configuracion@_@astro
var page = () => configuracion_exports;
//#endregion
export { page };
