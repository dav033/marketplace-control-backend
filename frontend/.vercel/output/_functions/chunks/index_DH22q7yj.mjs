import { t as __exportAll } from "./rolldown-runtime_D7D4PA-g.mjs";
import { C as createAstro, a as Fragment, d as renderTemplate, f as maybeRenderHead, i as renderComponent, m as addAttribute } from "./server_BgOX8cb3.mjs";
import { t as createComponent } from "./compiler_b2Y2_jyB.mjs";
import { t as $$AppLayout } from "./AppLayout_Cj4KBcmR.mjs";
import { n as fetchDashboard } from "./api-client_DMiF7Ths.mjs";
import { t as $$StatusBadge } from "./StatusBadge_Cnxjm7eW.mjs";
//#region src/components/MetricCard.astro
createAstro("https://astro.build");
var $$MetricCard = createComponent(($$result, $$props, $$slots) => {
	const Astro = $$result.createAstro($$props, $$slots);
	Astro.self = $$MetricCard;
	const { label, value, note, kind = "grid" } = Astro.props;
	return renderTemplate`${maybeRenderHead($$result)}<article class="metric"><div class="metric-top"><span>${label}</span><span class="metric-mark" aria-hidden="true">${kind === "pin" && renderTemplate`<svg viewBox="0 0 20 20"><path d="M10 18s6-5.2 6-10A6 6 0 0 0 4 8c0 4.8 6 10 6 10Z"></path><circle cx="10" cy="8" r="2"></circle></svg>`}${kind === "send" && renderTemplate`<svg viewBox="0 0 20 20"><path d="m18 2-7 16-3-7-6-3 16-6Z"></path><path d="m8 11 4-4"></path></svg>`}${kind === "inbox" && renderTemplate`<svg viewBox="0 0 20 20"><path d="M3 4h14v12H3z"></path><path d="M3 12h4l1 2h4l1-2h4"></path></svg>`}${kind === "spark" && renderTemplate`<svg viewBox="0 0 20 20"><path d="m10 2 1.6 5.4L17 9l-5.4 1.6L10 16l-1.6-5.4L3 9l5.4-1.6L10 2Z"></path></svg>`}</span></div><strong class="metric-number">${value}</strong><span class="metric-foot">${note}</span></article>`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/components/MetricCard.astro", void 0);
//#endregion
//#region src/pages/index.astro
var pages_exports = /* @__PURE__ */ __exportAll({
	default: () => $$Index,
	file: () => $$file,
	url: () => ""
});
createAstro("https://astro.build");
var $$Index = createComponent(async ($$result, $$props, $$slots) => {
	const Astro = $$result.createAstro($$props, $$slots);
	Astro.self = $$Index;
	const data = await fetchDashboard(Astro.url.origin);
	const activity = data.registrations.length ? data.registrations.map((item) => ({
		title: item.company_name || item.full_name || "Formulario recibido",
		text: `${item.email} envió sus datos para revisión.`,
		time: item.created_at,
		kind: "inbox"
	})) : [{
		title: "Lote listo para revisar",
		text: "Importa los proveedores devueltos por el prompt v2.8.",
		time: "Siguiente paso",
		kind: "pin"
	}, {
		title: "Campaña pendiente",
		text: "Los clics aparecerán aquí cuando exista un enlace rastreable.",
		time: "Sin actividad aún",
		kind: "send"
	}];
	return renderTemplate`${renderComponent($$result, "AppLayout", $$AppLayout, {
		"active": "Resumen",
		"title": "Resumen operativo",
		"data-astro-cid-lcdefpme": true
	}, { "default": ($$result) => renderTemplate`${maybeRenderHead($$result)}<div class="page" data-astro-cid-lcdefpme><header class="page-header" data-astro-cid-lcdefpme><div data-astro-cid-lcdefpme><p class="eyebrow" data-astro-cid-lcdefpme>Control room / hoy</p><h1 data-astro-cid-lcdefpme>Resumen operativo</h1><p class="page-intro" data-astro-cid-lcdefpme>De proveedor encontrado a conversación iniciada. Revisa el pulso del lote y decide la próxima acción.</p></div><a class="primary-button" href="/proveedores#importar" data-astro-cid-lcdefpme><svg viewBox="0 0 20 20" data-astro-cid-lcdefpme><path d="M10 3v10M6 9l4 4 4-4M4 17h12" data-astro-cid-lcdefpme></path></svg>Importar proveedores</a></header>${!data.connected && renderTemplate`<div class="notice" data-astro-cid-lcdefpme><span class="notice-dot" data-astro-cid-lcdefpme></span><span data-astro-cid-lcdefpme><strong data-astro-cid-lcdefpme>Modo demostración.</strong> Configura <code data-astro-cid-lcdefpme>DATABASE_URL</code> para ver datos reales de PostgreSQL.</span></div>`}<section class="metric-grid" aria-label="Indicadores principales" data-astro-cid-lcdefpme>${renderComponent($$result, "MetricCard", $$MetricCard, {
		"label": "Por revisar",
		"value": data.counts.candidates,
		"note": "candidatos en cola",
		"kind": "pin",
		"data-astro-cid-lcdefpme": true
	})}${renderComponent($$result, "MetricCard", $$MetricCard, {
		"label": "Contactados",
		"value": data.counts.contacted,
		"note": "con envío registrado",
		"kind": "send",
		"data-astro-cid-lcdefpme": true
	})}${renderComponent($$result, "MetricCard", $$MetricCard, {
		"label": "Mostraron interés",
		"value": data.counts.interested,
		"note": "hicieron clic",
		"kind": "spark",
		"data-astro-cid-lcdefpme": true
	})}${renderComponent($$result, "MetricCard", $$MetricCard, {
		"label": "Formularios",
		"value": data.counts.submissions,
		"note": "esperando revisión",
		"kind": "inbox",
		"data-astro-cid-lcdefpme": true
	})}</section><div class="content-grid" data-astro-cid-lcdefpme><section data-astro-cid-lcdefpme><div class="section-heading" data-astro-cid-lcdefpme><h2 data-astro-cid-lcdefpme>Cola de proveedores</h2><a class="text-link" href="/proveedores" data-astro-cid-lcdefpme>Ver todos</a></div><div class="panel table-wrap" data-astro-cid-lcdefpme><table class="data-table" data-astro-cid-lcdefpme><thead data-astro-cid-lcdefpme><tr data-astro-cid-lcdefpme><th data-astro-cid-lcdefpme>Proveedor</th><th data-astro-cid-lcdefpme>Ubicación</th><th data-astro-cid-lcdefpme>Evidencia</th><th data-astro-cid-lcdefpme>Estado</th><th data-astro-cid-lcdefpme>Actividad</th></tr></thead><tbody data-astro-cid-lcdefpme>${data.providers.slice(0, 5).map((provider) => renderTemplate`<tr data-astro-cid-lcdefpme><td data-astro-cid-lcdefpme><a class="provider-link"${addAttribute(`/proveedores/${provider.provider_id}`, "href")} data-astro-cid-lcdefpme>${provider.display_name}</a><div class="muted" data-astro-cid-lcdefpme>${provider.category}</div></td><td data-astro-cid-lcdefpme>${provider.city}</td><td data-astro-cid-lcdefpme><span class="rating" data-astro-cid-lcdefpme>${provider.rating ?? "—"} <span data-astro-cid-lcdefpme>★</span></span><div class="muted" data-astro-cid-lcdefpme>${provider.review_count ?? "—"} reseñas</div></td><td data-astro-cid-lcdefpme>${renderComponent($$result, "StatusBadge", $$StatusBadge, {
		"status": provider.status,
		"data-astro-cid-lcdefpme": true
	})}</td><td class="muted" data-astro-cid-lcdefpme>${provider.last_activity ?? "—"}</td></tr>`)}</tbody></table></div></section><section data-astro-cid-lcdefpme><div class="section-heading" data-astro-cid-lcdefpme><h2 data-astro-cid-lcdefpme>Actividad reciente</h2><a class="text-link" href="/formularios" data-astro-cid-lcdefpme>Bandeja</a></div><div class="panel" data-astro-cid-lcdefpme><ul class="activity-list" data-astro-cid-lcdefpme>${activity.map((item) => renderTemplate`<li class="activity-item" data-astro-cid-lcdefpme><span class="activity-dot" aria-hidden="true" data-astro-cid-lcdefpme><svg viewBox="0 0 20 20" data-astro-cid-lcdefpme>${item.kind === "send" ? renderTemplate`${renderComponent($$result, "Fragment", Fragment, {}, { "default": ($$result) => renderTemplate`<path d="m18 2-7 16-3-7-6-3 16-6Z" data-astro-cid-lcdefpme></path><path d="m8 11 4-4" data-astro-cid-lcdefpme></path>` })}` : item.kind === "pin" ? renderTemplate`${renderComponent($$result, "Fragment", Fragment, {}, { "default": ($$result) => renderTemplate`<path d="M10 18s6-5.2 6-10A6 6 0 0 0 4 8c0 4.8 6 10 6 10Z" data-astro-cid-lcdefpme></path><circle cx="10" cy="8" r="2" data-astro-cid-lcdefpme></circle>` })}` : renderTemplate`${renderComponent($$result, "Fragment", Fragment, {}, { "default": ($$result) => renderTemplate`<path d="M3 4h14v12H3z" data-astro-cid-lcdefpme></path><path d="M3 12h4l1 2h4l1-2h4" data-astro-cid-lcdefpme></path>` })}`}</svg></span><span data-astro-cid-lcdefpme><strong data-astro-cid-lcdefpme>${item.title}</strong><p data-astro-cid-lcdefpme>${item.text}</p><small class="activity-time" data-astro-cid-lcdefpme>${item.time}</small></span></li>`)}</ul></div></section></div></div>` })}`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/index.astro", void 0);
var $$file = "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/index.astro";
//#endregion
//#region \0virtual:astro:page:src/pages/index@_@astro
var page = () => pages_exports;
//#endregion
export { page };
