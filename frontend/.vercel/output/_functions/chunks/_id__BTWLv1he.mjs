import { t as __exportAll } from "./rolldown-runtime_D7D4PA-g.mjs";
import { C as createAstro, d as renderTemplate, f as maybeRenderHead, i as renderComponent, m as addAttribute } from "./server_BgOX8cb3.mjs";
import { t as createComponent } from "./compiler_b2Y2_jyB.mjs";
import { t as $$AppLayout } from "./AppLayout_Cj4KBcmR.mjs";
import { i as fetchProvider } from "./api-client_DMiF7Ths.mjs";
import { t as $$StatusBadge } from "./StatusBadge_Cnxjm7eW.mjs";
//#region src/pages/proveedores/[id].astro
var _id__exports = /* @__PURE__ */ __exportAll({
	default: () => $$Id,
	file: () => $$file,
	url: () => $$url
});
createAstro("https://astro.build");
var $$Id = createComponent(async ($$result, $$props, $$slots) => {
	const Astro = $$result.createAstro($$props, $$slots);
	Astro.self = $$Id;
	const id = Astro.params.id ?? "";
	const provider = await fetchProvider(id, Astro.url.origin);
	if (!provider) return Astro.redirect("/proveedores");
	return renderTemplate`${renderComponent($$result, "AppLayout", $$AppLayout, {
		"active": "Proveedores",
		"title": provider.display_name,
		"data-astro-cid-g7xg7fmw": true
	}, { "default": ($$result) => renderTemplate`${maybeRenderHead($$result)}<div class="page" data-astro-cid-g7xg7fmw><div class="page-header" data-astro-cid-g7xg7fmw><div data-astro-cid-g7xg7fmw><a class="text-link" href="/proveedores" data-astro-cid-g7xg7fmw>← Volver a proveedores</a><h1 style="margin-top:14px" data-astro-cid-g7xg7fmw>${provider.display_name}</h1><p class="page-intro" data-astro-cid-g7xg7fmw>Ficha de evidencia y seguimiento. Los estados se cambian con una decisión explícita.</p></div>${renderComponent($$result, "StatusBadge", $$StatusBadge, {
		"status": provider.status,
		"data-astro-cid-g7xg7fmw": true
	})}</div><div class="detail-grid" data-astro-cid-g7xg7fmw><section class="panel detail-panel" data-astro-cid-g7xg7fmw><div class="detail-title" data-astro-cid-g7xg7fmw><div data-astro-cid-g7xg7fmw><p class="eyebrow" data-astro-cid-g7xg7fmw>Ficha de proveedor</p><h2 style="margin:0;font-size:19px" data-astro-cid-g7xg7fmw>Evidencia disponible</h2><div class="detail-meta" data-astro-cid-g7xg7fmw><span class="meta-chip" data-astro-cid-g7xg7fmw>${provider.city}</span><span class="meta-chip" data-astro-cid-g7xg7fmw>${provider.category}</span>${provider.additional_categories?.map((extra) => renderTemplate`<span class="meta-chip meta-chip-extra" data-astro-cid-g7xg7fmw>+ ${extra}</span>`)}<span class="meta-chip" data-astro-cid-g7xg7fmw>Canal: ${provider.contact_channel === "email" ? "Correo corporativo" : "WhatsApp"}</span><span class="meta-chip" data-astro-cid-g7xg7fmw>Fuente: ${provider.discovery_source ?? "sin registrar"}</span></div></div></div><div class="field-list" data-astro-cid-g7xg7fmw><div class="field" data-astro-cid-g7xg7fmw><label data-astro-cid-g7xg7fmw>Calificación pública</label><span class="rating" data-astro-cid-g7xg7fmw>${provider.rating ?? "Sin dato"} ${provider.rating && renderTemplate`<span data-astro-cid-g7xg7fmw>★</span>`}</span></div><div class="field" data-astro-cid-g7xg7fmw><label data-astro-cid-g7xg7fmw>Reseñas</label><span data-astro-cid-g7xg7fmw>${provider.review_count ?? "Sin dato"}</span></div><div class="field" data-astro-cid-g7xg7fmw><label data-astro-cid-g7xg7fmw>Contacto</label><span data-astro-cid-g7xg7fmw>${provider.contact_email ?? "Aún no encontrado"}</span></div><div class="field" data-astro-cid-g7xg7fmw><label data-astro-cid-g7xg7fmw>Última actividad</label><span data-astro-cid-g7xg7fmw>${provider.last_activity ?? "Sin actividad"}</span></div></div></section><section class="panel detail-panel" data-astro-cid-g7xg7fmw><div class="section-heading" data-astro-cid-g7xg7fmw><h2 data-astro-cid-g7xg7fmw>Reputación por plataforma</h2></div>${provider.sources.length ? renderTemplate`<ul class="platform-list" data-astro-cid-g7xg7fmw>${provider.sources.map((source) => renderTemplate`<li data-astro-cid-g7xg7fmw><span class="platform-name" data-astro-cid-g7xg7fmw>${source.source_name}</span><span class="platform-score" data-astro-cid-g7xg7fmw>★ ${source.observed_rating ?? "Sin dato"}</span><span class="platform-reviews" data-astro-cid-g7xg7fmw>${source.observed_reviews ?? 0} reseñas</span>${source.source_url && renderTemplate`<a class="text-link"${addAttribute(source.source_url, "href")} target="_blank" rel="noreferrer" data-astro-cid-g7xg7fmw>Ver fuente</a>`}</li>`)}</ul>` : renderTemplate`<p class="muted" data-astro-cid-g7xg7fmw>Sin reputación registrada por plataforma todavía.</p>`}</section><section class="panel detail-panel" data-astro-cid-g7xg7fmw><div class="section-heading" data-astro-cid-g7xg7fmw><h2 data-astro-cid-g7xg7fmw>Próximos eventos</h2></div><ul class="timeline" data-astro-cid-g7xg7fmw><li data-astro-cid-g7xg7fmw><span class="timeline-mark" data-astro-cid-g7xg7fmw></span><div data-astro-cid-g7xg7fmw><strong data-astro-cid-g7xg7fmw>Proveedor extraído</strong><p data-astro-cid-g7xg7fmw>Entró al lote desde el prompt de curaduría.</p></div></li><li data-astro-cid-g7xg7fmw><span class="timeline-mark" style="background:var(--signal);box-shadow:0 0 0 2px var(--signal)" data-astro-cid-g7xg7fmw></span><div data-astro-cid-g7xg7fmw><strong data-astro-cid-g7xg7fmw>Acción siguiente</strong><p data-astro-cid-g7xg7fmw>Encontrar contacto válido o enviar campaña aprobada.</p></div></li><li data-astro-cid-g7xg7fmw><span class="timeline-mark" style="background:var(--surface);box-shadow:0 0 0 2px var(--line-strong)" data-astro-cid-g7xg7fmw></span><div data-astro-cid-g7xg7fmw><strong data-astro-cid-g7xg7fmw>Formulario</strong><p data-astro-cid-g7xg7fmw>Los datos aparecerán aquí cuando el proveedor complete el enlace.</p></div></li></ul></section></div></div>` })}`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/proveedores/[id].astro", void 0);
var $$file = "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/proveedores/[id].astro";
var $$url = "/proveedores/[id]";
//#endregion
//#region \0virtual:astro:page:src/pages/proveedores/[id]@_@astro
var page = () => _id__exports;
//#endregion
export { page };
