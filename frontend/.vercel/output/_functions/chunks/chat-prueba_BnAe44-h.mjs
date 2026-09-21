import { t as __exportAll } from "./rolldown-runtime_D7D4PA-g.mjs";
import { d as renderTemplate, f as maybeRenderHead, i as renderComponent } from "./server_BgOX8cb3.mjs";
import { t as createComponent } from "./compiler_b2Y2_jyB.mjs";
import { t as renderScript } from "./script_h0d3jHTH.mjs";
import { t as $$AppLayout } from "./AppLayout_Cj4KBcmR.mjs";
//#region src/pages/chat-prueba.astro
var chat_prueba_exports = /* @__PURE__ */ __exportAll({
	default: () => $$ChatPrueba,
	file: () => $$file,
	url: () => $$url
});
var $$ChatPrueba = createComponent(($$result, $$props, $$slots) => {
	const disponible = false;
	return renderTemplate`${renderComponent($$result, "AppLayout", $$AppLayout, {
		"active": "Chat de prueba",
		"title": "Chat de prueba",
		"data-astro-cid-ehfugmbz": true
	}, { "default": ($$result2) => renderTemplate`${maybeRenderHead($$result2)}<div class="page" data-astro-cid-ehfugmbz><header class="page-header" data-astro-cid-ehfugmbz><div data-astro-cid-ehfugmbz><p class="eyebrow" data-astro-cid-ehfugmbz>Pruebas</p><h1 data-astro-cid-ehfugmbz>Chat de prueba del bot</h1><p class="page-intro" data-astro-cid-ehfugmbz>La misma conversación que tendrá un proveedor por WhatsApp, sin depender de Meta. Rellena el formulario de registro hablando.</p></div><button class="secondary-button" id="reiniciar" type="button" data-astro-cid-ehfugmbz>Reiniciar</button></header>${renderTemplate`<div class="notice" data-astro-cid-ehfugmbz><span class="notice-dot" data-astro-cid-ehfugmbz></span><span data-astro-cid-ehfugmbz><strong data-astro-cid-ehfugmbz>Solo en desarrollo.</strong> Este chat escribe fichas sin el token del correo, así que no se sirve en producción.</span></div>`}${disponible}</div>` })}${renderScript($$result, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/chat-prueba.astro?astro&type=script&index=0&lang.ts")}`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/chat-prueba.astro", void 0);
var $$file = "C:/Users/davidt/Desktop/marketplace-control/frontend/src/pages/chat-prueba.astro";
var $$url = "/chat-prueba";
//#endregion
//#region \0virtual:astro:page:src/pages/chat-prueba@_@astro
var page = () => chat_prueba_exports;
//#endregion
export { page };
