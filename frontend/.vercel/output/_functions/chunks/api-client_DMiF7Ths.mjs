import { n as SERVICE_TOKEN_HEADER, t as REGISTRATION_CATEGORIES } from "./contract_B7tfa3pq.mjs";
//#region src/lib/demo.ts
var providers = [
	{
		provider_id: "demo-1",
		display_name: "Muestra: Banquetes del Norte",
		category: "Comida y bebida",
		city: "Barranquilla",
		rating: 4.8,
		review_count: 42,
		contact_channel: "whatsapp",
		phone: "+57 300 1234567",
		status: "candidate",
		discovery_source: "Prompt v2.8 · muestra",
		contact_email: null,
		last_activity: "Ayer",
		platform_count: 2,
		additional_categories: ["Entretenimiento"]
	},
	{
		provider_id: "demo-2",
		display_name: "Muestra: Estudio Luz Caribe",
		category: "Fotografía",
		city: "Barranquilla",
		rating: 4.7,
		review_count: 31,
		contact_channel: "whatsapp",
		phone: "+57 300 1234567",
		status: "under_review",
		discovery_source: "Prompt v2.8 · muestra",
		contact_email: "pendiente",
		last_activity: "Hace 2 días",
		platform_count: 1,
		additional_categories: []
	},
	{
		provider_id: "demo-5",
		display_name: "Muestra: Carpas Malecón",
		category: "Carpas y mobiliario",
		city: "Barranquilla",
		rating: 4.5,
		review_count: 18,
		contact_channel: "email",
		phone: "+57 300 1234567",
		status: "unconfirmed",
		discovery_source: "Prompt v2.8 · muestra",
		contact_email: "registrado",
		last_activity: "Hoy",
		platform_count: 1,
		additional_categories: []
	},
	{
		provider_id: "demo-3",
		display_name: "Muestra: Sonido Patio",
		category: "Música",
		city: "Medellín",
		rating: 4.9,
		review_count: 87,
		contact_channel: "email",
		phone: "+57 300 1234567",
		status: "approved",
		discovery_source: "Prompt v2.8 · muestra",
		contact_email: "registrado",
		last_activity: "Hace 4 días",
		platform_count: 1,
		additional_categories: []
	},
	{
		provider_id: "demo-4",
		display_name: "Muestra: Salón La Estación",
		category: "Venues",
		city: "Bogotá",
		rating: 4.6,
		review_count: 119,
		contact_channel: "whatsapp",
		phone: "+57 300 1234567",
		status: "candidate",
		discovery_source: "Prompt v2.8 · muestra",
		contact_email: null,
		last_activity: "Hace 5 días",
		platform_count: 3,
		additional_categories: ["Comida y Bebida", "Entretenimiento"]
	}
];
var registrations = [{
	submission_id: "demo-form-1",
	provider_id: "demo-3",
	company_name: "Muestra: Sonido Patio",
	full_name: "Contacto de muestra",
	email: "demo@example.com",
	submission_status: "new",
	created_at: "Hoy, 09:42"
}];
function demoDashboard() {
	return {
		counts: {
			candidates: 18,
			contacted: 7,
			interested: 3,
			submissions: 1
		},
		providers,
		registrations,
		connected: false
	};
}
function demoProvider(id) {
	const provider = providers.find((provider) => provider.provider_id === id) ?? providers[0];
	return {
		...provider,
		sources: provider.rating ? [{
			source_name: "Google",
			observed_rating: provider.rating,
			observed_reviews: provider.review_count,
			source_url: null
		}] : []
	};
}
//#endregion
//#region src/lib/api-client.ts
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
	_: "C:/Program Files/nodejs/node.exe"
})[name] ?? process.env[name];
function backendBase(origin) {
	return (env("BACKEND_URL") || origin).replace(/\/$/, "");
}
var BackendUnavailableError = class extends Error {
	path;
	status;
	cause;
	constructor(path, status, cause) {
		super(`BACKEND_UNAVAILABLE ${path}${status ? ` (${status})` : ""}`);
		this.path = path;
		this.status = status;
		this.cause = cause;
		this.name = "BackendUnavailableError";
	}
};
async function get(path, origin) {
	const token = env("BACKEND_SERVICE_TOKEN");
	const url = `${backendBase(origin)}${path}`;
	let response;
	try {
		response = await fetch(url, { headers: token ? { [SERVICE_TOKEN_HEADER]: token } : {} });
	} catch (cause) {
		throw new BackendUnavailableError(path, null, cause);
	}
	if (response.status === 404) throw new BackendUnavailableError(path, 404);
	if (!response.ok) throw new BackendUnavailableError(path, response.status);
	return await response.json();
}
async function fetchDashboard(origin) {
	try {
		return await get("/api/v1/dashboard", origin);
	} catch {
		return demoDashboard();
	}
}
async function fetchProvider(id, origin) {
	try {
		return await get(`/api/v1/providers/${encodeURIComponent(id)}`, origin);
	} catch (error) {
		if (error instanceof BackendUnavailableError && error.status === 404) return null;
		return demoProvider(id);
	}
}
async function fetchRegistration(id, origin) {
	try {
		return await get(`/api/v1/registrations/${encodeURIComponent(id)}`, origin);
	} catch (error) {
		if (error instanceof BackendUnavailableError && error.status === 404) return null;
		return demoDashboard().registrations.find((entry) => entry.submission_id === id) ?? null;
	}
}
async function fetchPreregistered(origin) {
	try {
		return (await get("/api/v1/preregistrations", origin)).providers ?? [];
	} catch {
		return [];
	}
}
async function fetchCampaignOverview(origin) {
	try {
		return await get("/api/v1/campaigns/overview", origin);
	} catch {
		return {
			connected: false,
			campaigns: [],
			recipients: [],
			cities: [],
			statuses: [],
			categories: [],
			defaultSender: "",
			omnisendReady: false,
			qaRecipientsLabel: "",
			emailEligibleCount: 0,
			qaRecipientsCount: 0
		};
	}
}
async function fetchRegistrationLink(token, origin) {
	try {
		return await get(`/api/v1/registration-links/${encodeURIComponent(token)}`, origin);
	} catch {
		return {
			providerName: "tu negocio de eventos",
			linkState: "valid",
			submittedAt: null,
			categories: REGISTRATION_CATEGORIES
		};
	}
}
//#endregion
export { fetchRegistration as a, fetchProvider as i, fetchDashboard as n, fetchRegistrationLink as o, fetchPreregistered as r, fetchCampaignOverview as t };
