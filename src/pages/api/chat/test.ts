import type { APIRoute } from 'astro';
import { emptyState, greeting, runTurn, stateFromProvider, type ConversationState } from '../../../lib/conversation-runner';
import { getContactableCandidates } from '../../../lib/data';
import type { SeedProvider } from '../../../lib/registration-chat';

/**
 * Chat de prueba local: el mismo agente de WhatsApp, sin Meta de por medio.
 *
 * Solo existe en desarrollo. Es un camino que escribe fichas reales en la base saltándose el token
 * del correo, así que en producción sería una puerta abierta para crear registros sin control.
 */

const sessions = (globalThis as typeof globalThis & { __chatTestSessions?: Map<string, ConversationState> });
function registry() {
  if (!sessions.__chatTestSessions) sessions.__chatTestSessions = new Map();
  return sessions.__chatTestSessions;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function devOnly() {
  return import.meta.env.DEV ? null : json({ ok: false, error: 'NOT_AVAILABLE' }, 404);
}

export const GET: APIRoute = async () => {
  const blocked = devOnly();
  if (blocked) return blocked;
  // La lista de candidatos viaja con el saludo: el chat deja escoger a quién se le escribe.
  const candidates = await getContactableCandidates();
  return json({
    ok: true,
    greeting: greeting(),
    candidates: candidates.map((row) => ({
      providerId: row.provider_id,
      displayName: row.display_name,
      city: row.city,
      category: row.category,
      additionalCategories: row.additional_categories ?? [],
      phone: row.phone,
      email: row.contact_email,
      channel: row.contact_channel,
    })),
  });
};

export const POST: APIRoute = async ({ request }) => {
  const blocked = devOnly();
  if (blocked) return blocked;

  let payload: { sessionId?: string; message?: string; reset?: boolean; provider?: SeedProvider };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ ok: false, error: 'BODY_NOT_JSON' }, 400);
  }

  const sessionId = String(payload.sessionId ?? '').trim();
  if (!sessionId) return json({ ok: false, error: 'SESSION_REQUIRED' }, 400);

  if (payload.reset) {
    // Reiniciar con un candidato simula que le escribimos primero: el agente conoce su ficha y sabe
    // qué le dijo la plantilla. Sin candidato, simula a alguien que nos escribe por su cuenta.
    const opening = greeting(payload.provider);
    const seeded = payload.provider ? stateFromProvider(payload.provider, opening) : emptyState();
    registry().set(sessionId, seeded);
    return json({
      ok: true,
      reply: opening,
      outcome: 'opening',
      draft: seeded.draft,
      finished: false,
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
  });
};
