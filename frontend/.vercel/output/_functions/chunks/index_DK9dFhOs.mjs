import { t as __exportAll } from "./rolldown-runtime_D7D4PA-g.mjs";
import { C as createAstro, d as renderTemplate, f as maybeRenderHead, i as renderComponent, m as addAttribute } from "./server_BgOX8cb3.mjs";
import { t as createComponent } from "./compiler_b2Y2_jyB.mjs";
import { t as $$AppLayout } from "./AppLayout_Cj4KBcmR.mjs";
import { n as fetchDashboard } from "./api-client_DMiF7Ths.mjs";
import { t as $$StatusBadge } from "./StatusBadge_Cnxjm7eW.mjs";
//#region src/pages/formularios/index.astro
var formularios_exports = /* @__PURE__ */ __exportAll({
	default: () => $$Index,
	file: () => $$file,
	url: () => $$url
});
createAstro("https://astro.build");
var $$Index = createComponent(async ($$result, $$props, $$slots) => {
	const Astro = $$result.createAstro($$props, $$slots);
	Astro.self = $$Index;
	const data = await fetchDashboard(Astro.url.origin);
	return renderTemplate`${renderComponent($$result, "AppLayout", $$AppLayout, {
		"active": "Formularios",
		"title": "Formularios"
	}, { "default": ($$result) => renderTemplate`${maybeRenderHead($$result)}<div class="page"><header class="page-header"><div><p class="eyebrow">Respuesta de proveedores</p><h1>Formularios recibidos</h1><p class="page-intro">Cada respuesta requiere revisión humana. Recibir datos no equivale a aprobación.</p></div></header><section class="panel table-panel"><div class="panel-head"><span><strong>Bandeja de entrada</strong> · ${data.registrations.length} visibles</span><span>Más recientes primero</span></div>${data.registrations.length ? renderTemplate`<div class="table-wrap"><table class="data-table"><thead><tr><th>Empresa / contacto</th><th>Correo</th><th>Estado</th><th>Recibido</th><th></th></tr></thead><tbody>${data.registrations.map((item) => renderTemplate`<tr><td><strong>${item.company_name ?? "Sin empresa"}</strong><div class="muted">${item.full_name ?? "Nombre pendiente"}</div></td><td>${item.email}</td><td>${renderComponent($$result, "StatusBadge", $$StatusBadge, { "status": item.submission_status })}</td><td class="muted">${item.created_at}</td><td><a class="text-link"${addAttribute(`/formularios/${item.submission_id}`, "href")}>Revisar</a></td></tr>`)}</tbody></table></div>` : renderTemplate`<div class="empty-state"><strong>Aún no hay formularios</strong><p>Cuando un proveedor complete un enlace, su respuesta aparecerá aquí para revisión.</p></div>`}</section></div>` })}`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/formularios/index.astro", void 0);
var $$file = "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/formularios/index.astro";
var $$url = "/formularios";
//#endregion
//#region \0virtual:astro:page:src/pages/formularios/index@_@astro
var page = () => formularios_exports;
//#endregion
export { page };
