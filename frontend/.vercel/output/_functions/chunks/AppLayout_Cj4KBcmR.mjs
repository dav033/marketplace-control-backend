import { C as createAstro, c as renderSlot, d as renderTemplate, m as addAttribute, p as renderHead } from "./server_BgOX8cb3.mjs";
import { t as createComponent } from "./compiler_b2Y2_jyB.mjs";
//#region src/layouts/AppLayout.astro
createAstro("https://astro.build");
var $$AppLayout = createComponent(($$result, $$props, $$slots) => {
	const Astro2 = $$result.createAstro($$props, $$slots);
	Astro2.self = $$AppLayout;
	const { title = "Resumen operativo", active = "Resumen", publicView = false } = Astro2.props;
	const nav = [
		{
			label: "Resumen",
			href: "/",
			icon: "grid"
		},
		{
			label: "Proveedores",
			href: "/proveedores",
			icon: "pin"
		},
		{
			label: "Campañas",
			href: "/campanas",
			icon: "send"
		},
		{
			label: "Preregistrados",
			href: "/preregistrados",
			icon: "pin"
		},
		{
			label: "Formularios",
			href: "/formularios",
			icon: "inbox"
		},
		...[]
	];
	return renderTemplate`<html lang="es" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><meta name="description" content="Panel operativo de proveedores de eventos."><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap"><title>${title} · Marketplace Control</title>${renderHead($$result)}</head><body${addAttribute({ "public-layout": publicView }, "class:list")}><!--
      THESIS: este panel convierte evidencia dispersa en una cola operable; rechaza el dashboard decorativo que oculta la siguiente acción.
      OWN-WORLD: sala oscura permanente; superficies de carbón, tinta clara, azul de acción y lima de señal reservado a lo que exige revisión humana.
      TEMA: un solo juego de tokens; el oscuro es el valor de :root y el operador no lo cambia. El claro queda definido en [data-theme="light"] para uso interno.
      STORY: el operador ve qué entró, qué se contactó, quién mostró interés y qué formulario requiere revisión.
      FIRST VIEWPORT: rail izquierdo, encabezado con conexión, cuatro métricas y cola de proveedores con actividad reciente.
      FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
    -->${publicView ? renderTemplate`${renderSlot($$result, $$slots["default"])}` : renderTemplate`<div class="app-shell"><aside class="sidebar"><a class="brand" href="/" aria-label="Marketplace Control, inicio"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span><span><strong>marketplace</strong><small>control room</small></span></a><div class="rail-label">Operación</div><nav aria-label="Navegación principal">${nav.map((item) => renderTemplate`<a${addAttribute({
		"nav-item": true,
		active: active === item.label
	}, "class:list")}${addAttribute(item.href, "href")}><span class="nav-icon" aria-hidden="true">${item.icon === "grid" && renderTemplate`<svg viewBox="0 0 20 20"><rect x="2" y="2" width="6" height="6" rx="1"></rect><rect x="12" y="2" width="6" height="6" rx="1"></rect><rect x="2" y="12" width="6" height="6" rx="1"></rect><rect x="12" y="12" width="6" height="6" rx="1"></rect></svg>`}${item.icon === "pin" && renderTemplate`<svg viewBox="0 0 20 20"><path d="M10 18s6-5.2 6-10A6 6 0 0 0 4 8c0 4.8 6 10 6 10Z"></path><circle cx="10" cy="8" r="2"></circle></svg>`}${item.icon === "send" && renderTemplate`<svg viewBox="0 0 20 20"><path d="m18 2-7 16-3-7-6-3 16-6Z"></path><path d="m8 11 4-4"></path></svg>`}${item.icon === "inbox" && renderTemplate`<svg viewBox="0 0 20 20"><path d="M3 4h14v12H3z"></path><path d="M3 12h4l1 2h4l1-2h4"></path></svg>`}</span>${item.label}</a>`)}</nav><div class="sidebar-bottom"><div class="rail-label">Sistema</div><a class="nav-item" href="/configuracion"><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M8 2h4l.6 2.1a6.4 6.4 0 0 1 1.5.9l2.1-.4 2 3.4-1.5 1.6a6.5 6.5 0 0 1 0 1.8l1.5 1.6-2 3.4-2.1-.4a6.4 6.4 0 0 1-1.5.9L12 19H8l-.6-2.1a6.4 6.4 0 0 1-1.5-.9l-2.1.4-2-3.4 1.5-1.6a6.5 6.5 0 0 1 0-1.8L3.8 8 5.8 4.6l2.1.4a6.4 6.4 0 0 1 1.5-.9L8 2Z"></path><circle cx="10" cy="10" r="2.5"></circle></svg></span>Configuración</a></div><div class="operator-chip"><span class="avatar">DT</span><span><strong>David</strong><small>Operador</small></span><span class="online-dot"></span></div></aside><main class="main-content"><header class="topbar"><div class="mobile-brand"><span class="brand-mark"><span></span><span></span><span></span></span><strong>marketplace</strong></div><div class="topbar-actions"><span class="connection"><span class="online-dot"></span> Conectado a operación</span><button class="icon-button" aria-label="Notificaciones"><svg viewBox="0 0 20 20"><path d="M4 14h12l-1.2-1.8V8a4.8 4.8 0 0 0-9.6 0v4.2L4 14Z"></path><path d="M8 16h4"></path></svg></button></div></header>${renderSlot($$result, $$slots["default"])}</main></div>`}</body></html>`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/layouts/AppLayout.astro", void 0);
//#endregion
export { $$AppLayout as t };
