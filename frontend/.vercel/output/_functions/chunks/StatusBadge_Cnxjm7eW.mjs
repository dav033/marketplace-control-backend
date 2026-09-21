import { C as createAstro, d as renderTemplate, f as maybeRenderHead, m as addAttribute } from "./server_BgOX8cb3.mjs";
import { t as createComponent } from "./compiler_b2Y2_jyB.mjs";
//#region src/components/StatusBadge.astro
createAstro("https://astro.build");
var $$StatusBadge = createComponent(($$result, $$props, $$slots) => {
	const Astro = $$result.createAstro($$props, $$slots);
	Astro.self = $$StatusBadge;
	const { status } = Astro.props;
	return renderTemplate`${maybeRenderHead($$result)}<span${addAttribute(`status status-${status}`, "class")}>${{
		candidate: "Candidato",
		unconfirmed: "Registrado",
		under_review: "En revisión",
		approved: "Aprobado",
		rejected: "Rechazado",
		archived: "Archivado",
		new: "Nuevo",
		reviewing: "Revisando",
		converted: "Convertido",
		spam: "Spam"
	}[status] ?? status}</span>`;
}, "C:/Users/davidt/Desktop/marketplace-control/frontend/src/components/StatusBadge.astro", void 0);
//#endregion
export { $$StatusBadge as t };
