import { t as __exportAll } from "./rolldown-runtime_D7D4PA-g.mjs";
import { C as createAstro, d as renderTemplate, f as maybeRenderHead, i as renderComponent } from "./server_BgOX8cb3.mjs";
import { t as createComponent } from "./compiler_b2Y2_jyB.mjs";
import { t as $$AppLayout } from "./AppLayout_Cj4KBcmR.mjs";
import { a as fetchRegistration } from "./api-client_DMiF7Ths.mjs";
import { t as $$StatusBadge } from "./StatusBadge_Cnxjm7eW.mjs";
//#region src/pages/formularios/[id].astro
var _id__exports = /* @__PURE__ */ __exportAll({
	default: () => $$Id,
	file: () => $$file,
	url: () => $$url
});
createAstro("https://astro.build");
var $$Id = createComponent(async ($$result, $$props, $$slots) => {
	const Astro = $$result.createAstro($$props, $$slots);
	Astro.self = $$Id;
	const item = await fetchRegistration(Astro.params.id ?? "", Astro.url.origin);
	if (!item) return Astro.redirect("/formularios");
	return renderTemplate`${renderComponent($$result, "AppLayout", $$AppLayout, {
		"active": "Formularios",
		"title": "Revisión de formulario",
		"data-astro-cid-xzpop3ly": true
	}, { "default": ($$result) => renderTemplate`${maybeRenderHead($$result)}<div class="page" data-astro-cid-xzpop3ly><div class="page-header" data-astro-cid-xzpop3ly><div data-astro-cid-xzpop3ly><a class="text-link" href="/formularios" data-astro-cid-xzpop3ly>← Volver a formularios</a><h1 style="margin-top:14px" data-astro-cid-xzpop3ly>Revisión de respuesta</h1><p class="page-intro" data-astro-cid-xzpop3ly>Confirma identidad, datos de contacto y consentimiento antes de cambiar el estado.</p></div>${renderComponent($$result, "StatusBadge", $$StatusBadge, {
		"status": item.submission_status,
		"data-astro-cid-xzpop3ly": true
	})}</div><div class="detail-grid" data-astro-cid-xzpop3ly><section class="panel detail-panel" data-astro-cid-xzpop3ly><div class="field-list" data-astro-cid-xzpop3ly><div class="field" data-astro-cid-xzpop3ly><label data-astro-cid-xzpop3ly>Empresa</label><span data-astro-cid-xzpop3ly>${item.company_name ?? "No informado"}</span></div><div class="field" data-astro-cid-xzpop3ly><label data-astro-cid-xzpop3ly>Nombre</label><span data-astro-cid-xzpop3ly>${item.full_name ?? "No informado"}</span></div><div class="field" data-astro-cid-xzpop3ly><label data-astro-cid-xzpop3ly>Correo</label><span data-astro-cid-xzpop3ly>${item.email}</span></div><div class="field" data-astro-cid-xzpop3ly><label data-astro-cid-xzpop3ly>Recibido</label><span data-astro-cid-xzpop3ly>${item.created_at}</span></div></div><div style="display:flex;gap:9px;margin-top:28px" data-astro-cid-xzpop3ly><button class="primary-button" type="button" disabled data-astro-cid-xzpop3ly>Marcar aprobado</button><button class="secondary-button" type="button" disabled data-astro-cid-xzpop3ly>Solicitar datos</button></div></section><section class="panel detail-panel" data-astro-cid-xzpop3ly><div class="section-heading" data-astro-cid-xzpop3ly><h2 data-astro-cid-xzpop3ly>Checklist</h2></div><ul class="checklist" data-astro-cid-xzpop3ly><li data-astro-cid-xzpop3ly><span data-astro-cid-xzpop3ly>01</span>Consentimiento de privacidad guardado</li><li data-astro-cid-xzpop3ly><span data-astro-cid-xzpop3ly>02</span>Correo responde al proveedor correcto</li><li data-astro-cid-xzpop3ly><span data-astro-cid-xzpop3ly>03</span>Datos públicos siguen verificables</li></ul></section></div></div>` })}`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/formularios/[id].astro", void 0);
var $$file = "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/formularios/[id].astro";
var $$url = "/formularios/[id]";
//#endregion
//#region \0virtual:astro:page:src/pages/formularios/[id]@_@astro
var page = () => _id__exports;
//#endregion
export { page };
