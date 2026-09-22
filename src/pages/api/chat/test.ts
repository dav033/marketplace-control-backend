import type { APIRoute } from 'astro';
import { emptyState, greeting, runTurn, stateFromProvider, type ConversationState } from '../../../lib/conversation-runner';
import { getContactableCandidates, getProvider } from '../../../lib/data';
import { describeProfile, loadProviderProfile } from '../../../lib/provider-profile';
import type { SeedProvider } from '../../../lib/registration-chat';

/**
 * "Test mensajes": el mismo agente de WhatsApp, dentro del panel y sin Meta de por medio.
 *
 * Sirve para probar cómo conversa el agente con un proveedor concreto sin desplegar ni usar un
 * teléfono. Va detrás de la autenticación del panel (no es una ruta pública del middleware). Lo que
 * se guarde desde aquí queda con `consent_source = 'chat-prueba'` y nunca cambia el estado del
 * proveedor real (ver `registration-intake.ts`).
 */

const sessions = (globalThis as typeof globalThis & { __chatTestSessions?: Map<string, ConversationState> });
function registry() {
  if (!sessions.__chatTestSessions) sessions.__chatTestSessions = new Map();
  return sessions.__chatTestSessions;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export const GET: APIRoute = async () => {
  // La lista de candidatos para escoger con quién simular la conversación.
  const candidates = await getContactableCandidates(500).catch(() => []);
  return json({
    ok: true,
    candidates: candidates.map((row) => ({
      providerId: row.provider_id,
      displayName: row.display_name,
      city: row.city,
      category: row.category,
    })),
  });
};

export const POST: APIRoute = async ({ request }) => {
  let payload: { sessionId?: string; message?: string; reset?: boolean; providerId?: string };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ ok: false, error: 'BODY_NOT_JSON' }, 400);
  }

  const sessionId = String(payload.sessionId ?? '').trim();
  if (!sessionId) return json({ ok: false, error: 'SESSION_REQUIRED' }, 400);

  if (payload.reset) {
    // Con un proveedor, se simula que el sistema le escribió primero: el agente arranca con su ficha
    // y con la misma invitación que recibiría por WhatsApp. Sin proveedor, simula a alguien que nos
    // escribe por su cuenta. El proveedor se busca aquí, en la base: el navegador solo dice cuál.
    let seed: SeedProvider | undefined;
    let reputation: { rating: number | null; reviews: number | null } = { rating: null, reviews: null };
    if (payload.providerId) {
      const provider = await getProvider(payload.providerId);
      if (!provider) return json({ ok: false, error: 'PROVIDER_NOT_FOUND' }, 404);
      reputation = { rating: provider.rating === null ? null : Number(provider.rating), reviews: provider.review_count };
      seed = {
        providerId: provider.provider_id,
        displayName: provider.display_name,
        city: provider.city,
        category: provider.category,
        additionalCategories: provider.additional_categories ?? [],
        phone: provider.phone,
        email: provider.contact_email,
      };
    }

    const opening = greeting(seed);
    // Con proveedor, la invitación ya "salió": el estado arranca en mensaje enviado, como en WhatsApp.
    const seeded: ConversationState = seed
      ? { ...stateFromProvider(seed, opening), whatsapp: { status: 'mensaje_enviado', reason: null } }
      : emptyState();
    registry().set(sessionId, seeded);

    // Lo que el agente sabe del negocio, para que quien prueba vea con qué contexto conversa.
    const profile = seed ? await loadProviderProfile(seed.providerId).catch(() => null) : null;
    return json({
      ok: true,
      reply: opening,
      outcome: 'opening',
      draft: seeded.draft,
      finished: false,
      conversationStatus: seeded.whatsapp?.status ?? null,
      // Para la cabecera del chat: quién es y cómo le va en público.
      provider: seed
        ? { providerId: seed.providerId, displayName: seed.displayName.trim(), category: seed.category, city: seed.city, ...reputation }
        : null,
      context: profile ? describeProfile(profile) : null,
    });
  }

  const message = String(payload.message ?? '').trim();
  if (!message) return json({ ok: false, error: 'MESSAGE_REQUIRED' }, 400);

  const state = registry().get(sessionId) ?? emptyState();
  const result = await runTurn(state, message, { channel: 'chat-prueba', handle: sessionId });
  registry().set(sessionId, result.state);

  return json({
    ok: true,
    reply: result.reply,
    outcome: result.outcome,
    draft: result.state.draft,
    finished: result.state.finished,
    submissionId: result.state.submissionId ?? null,
    // Cómo quedaría clasificada la conversación. Aquí solo se muestra: una prueba no toca al proveedor.
    conversationStatus: result.state.whatsapp?.status ?? null,
  });
};
