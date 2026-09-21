import { t as __exportAll } from "./rolldown-runtime_D7D4PA-g.mjs";
import { C as createAstro, a as Fragment, d as renderTemplate, f as maybeRenderHead, i as renderComponent, m as addAttribute } from "./server_BgOX8cb3.mjs";
import { t as createComponent } from "./compiler_b2Y2_jyB.mjs";
import { t as $$AppLayout } from "./AppLayout_Cj4KBcmR.mjs";
import { r as fetchPreregistered } from "./api-client_DMiF7Ths.mjs";
//#region src/pages/preregistrados.astro
var preregistrados_exports = /* @__PURE__ */ __exportAll({
	default: () => $$Preregistrados,
	file: () => $$file,
	url: () => $$url
});
createAstro("https://astro.build");
var $$Preregistrados = createComponent(async ($$result, $$props, $$slots) => {
	const Astro = $$result.createAstro($$props, $$slots);
	Astro.self = $$Preregistrados;
	const proveedores = await fetchPreregistered(Astro.url.origin);
	const canal = (fuente) => {
		if (fuente === "whatsapp-bot") return "WhatsApp";
		if (fuente === "chat-prueba") return "Chat de prueba";
		if (fuente === "email-link") return "Enlace de correo";
		return "Sin registrar";
	};
	return renderTemplate`${renderComponent($$result, "AppLayout", $$AppLayout, {
		"active": "Preregistrados",
		"title": "Preregistrados",
		"data-astro-cid-f7emkagt": true
	}, { "default": ($$result) => renderTemplate`${maybeRenderHead($$result)}<div class="page" data-astro-cid-f7emkagt><header class="page-header" data-astro-cid-f7emkagt><div data-astro-cid-f7emkagt><p class="eyebrow" data-astro-cid-f7emkagt>Esperando aprobación</p><h1 data-astro-cid-f7emkagt>Proveedores preregistrados</h1><p class="page-intro" data-astro-cid-f7emkagt>Confirmaron sus datos por su cuenta. Nadie está aprobado todavía: aquí se compara lo que contaron con la evidencia pública que ya teníamos.</p></div><span class="count-chip" data-astro-cid-f7emkagt>${proveedores.length} en cola</span></header>${!proveedores.length && renderTemplate`<div class="empty-state" data-astro-cid-f7emkagt><strong data-astro-cid-f7emkagt>Todavía no hay proveedores preregistrados</strong><p data-astro-cid-f7emkagt>Cuando un candidato complete su registro —por WhatsApp o por el enlace del correo— aparecerá aquí para revisión.</p></div>`}<div class="prereg-grid" data-astro-cid-f7emkagt>${proveedores.map((proveedor) => renderTemplate`<article class="panel prereg" data-astro-cid-f7emkagt><div class="prereg-head" data-astro-cid-f7emkagt><div data-astro-cid-f7emkagt><a class="prereg-nombre"${addAttribute(`/proveedores/${proveedor.provider_id}`, "href")} data-astro-cid-f7emkagt>${proveedor.display_name}</a><div class="prereg-meta" data-astro-cid-f7emkagt>${proveedor.city && renderTemplate`<span class="meta-chip" data-astro-cid-f7emkagt>${proveedor.city}</span>`}${proveedor.category && renderTemplate`<span class="meta-chip" data-astro-cid-f7emkagt>${proveedor.category}</span>`}<span class="meta-chip" data-astro-cid-f7emkagt>Vía ${canal(proveedor.consent_source)}</span></div></div><div class="prereg-repu" data-astro-cid-f7emkagt>${proveedor.rating !== null ? renderTemplate`${renderComponent($$result, "Fragment", Fragment, {}, { "default": ($$result) => renderTemplate`<strong data-astro-cid-f7emkagt>${proveedor.rating} ★</strong><small data-astro-cid-f7emkagt>${proveedor.review_count ?? 0} reseñas</small>` })}` : renderTemplate`<small data-astro-cid-f7emkagt>Sin reputación</small>`}</div></div><dl class="prereg-datos" data-astro-cid-f7emkagt><div data-astro-cid-f7emkagt><dt data-astro-cid-f7emkagt>Contacto</dt><dd data-astro-cid-f7emkagt>${proveedor.full_name ?? "—"}</dd></div><div data-astro-cid-f7emkagt><dt data-astro-cid-f7emkagt>Correo</dt><dd data-astro-cid-f7emkagt>${proveedor.email ?? "—"}</dd></div><div data-astro-cid-f7emkagt><dt data-astro-cid-f7emkagt>Teléfono</dt><dd data-astro-cid-f7emkagt>${proveedor.phone ?? "—"}</dd></div><div data-astro-cid-f7emkagt><dt data-astro-cid-f7emkagt>Asistentes</dt><dd data-astro-cid-f7emkagt>${proveedor.volume_min !== null ? `de ${proveedor.volume_min} a ${proveedor.volume_max}` : "—"}</dd></div></dl>${proveedor.company_name && proveedor.company_name !== proveedor.display_name && renderTemplate`<p class="prereg-aviso" data-astro-cid-f7emkagt><strong data-astro-cid-f7emkagt>Se identificó como</strong> «${proveedor.company_name}», distinto al nombre con el que lo encontramos.</p>`}${proveedor.services.length > 0 && renderTemplate`<div class="prereg-listas" data-astro-cid-f7emkagt><span class="prereg-etiqueta" data-astro-cid-f7emkagt>Categorías</span><div class="prereg-tags" data-astro-cid-f7emkagt>${proveedor.services.map((s) => renderTemplate`<span class="meta-chip" data-astro-cid-f7emkagt>${s}</span>`)}</div></div>`}${proveedor.products.length > 0 && renderTemplate`<div class="prereg-listas" data-astro-cid-f7emkagt><span class="prereg-etiqueta" data-astro-cid-f7emkagt>Ofrece</span><div class="prereg-tags" data-astro-cid-f7emkagt>${proveedor.products.map((p) => renderTemplate`<span class="meta-chip meta-chip-extra" data-astro-cid-f7emkagt>${p}</span>`)}</div></div>`}${proveedor.description && renderTemplate`<p class="prereg-nota" data-astro-cid-f7emkagt>${proveedor.description}</p>`}<footer class="prereg-pie" data-astro-cid-f7emkagt><span${addAttribute(proveedor.marketing_consent ? "consent-si" : "consent-no", "class")} data-astro-cid-f7emkagt>${proveedor.marketing_consent ? "Aceptó comunicaciones comerciales" : "Sin consentimiento comercial"}</span><span class="muted" data-astro-cid-f7emkagt>${proveedor.submitted_at ?? "Sin fecha"}</span></footer></article>`)}</div></div>` })}`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/preregistrados.astro", void 0);
var $$file = "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/preregistrados.astro";
var $$url = "/preregistrados";
//#endregion
//#region \0virtual:astro:page:src/pages/preregistrados@_@astro
var page = () => preregistrados_exports;
//#endregion
export { page };
