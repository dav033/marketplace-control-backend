import { pool, query } from './db';
import type { ConversationState } from './conversation-runner';
import type { SeedProvider } from './registration-chat';

/**
 * Dónde vive el estado de las conversaciones de WhatsApp.
 *
 * En PostgreSQL y no en memoria del proceso, que es como estaba. La diferencia con el correo es
 * que allí el estado viaja en el token del enlace: el servidor puede reiniciarse cuantas veces
 * quiera y el proveedor sigue teniendo su formulario. Aquí los mensajes llegan sueltos al webhook
 * y lo único que los identifica es un número de teléfono, así que si el avance no está guardado, un
 * deploy deja a medias a todo el que estuviera contestando y el bot le vuelve a saludar de cero.
 *
 * Sin `DATABASE_URL` se cae a memoria para que el chat de prueba local siga funcionando. Eso es
 * aceptable en una prueba y no lo es en producción; por eso `isPersistent()` lo dice en voz alta.
 */

export type StoredConversation = {
  waId: string;
  providerId: string | null;
  profileName: string | null;
  /** null = todavía no ha contestado nunca: la ventana está cerrada. */
  lastInboundAtMs: number | null;
  state: ConversationState;
};

export function isPersistent() {
  return Boolean(pool);
}

// Respaldo en memoria, solo para cuando no hay base (pruebas locales y modo demostración).
const globalFallback = globalThis as typeof globalThis & {
  __whatsappFallback?: { conversations: Map<string, StoredConversation>; messages: Set<string>; suppressed: Set<string> };
};
function fallback() {
  if (!globalFallback.__whatsappFallback) {
    globalFallback.__whatsappFallback = { conversations: new Map(), messages: new Set(), suppressed: new Set() };
  }
  return globalFallback.__whatsappFallback;
}

export async function getConversation(waId: string): Promise<StoredConversation | undefined> {
  if (!pool) return fallback().conversations.get(waId);
  const result = await query<{ wa_id: string; provider_id: string | null; profile_name: string | null; last_inbound_at: Date | null; state: ConversationState }>(
    `SELECT wa_id, provider_id, profile_name, last_inbound_at, state
     FROM marketplace.whatsapp_conversations WHERE wa_id = $1`,
    [waId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    waId: row.wa_id,
    providerId: row.provider_id,
    profileName: row.profile_name,
    lastInboundAtMs: row.last_inbound_at ? row.last_inbound_at.getTime() : null,
    state: row.state ?? { draft: {}, finished: false },
  };
}

/**
 * Registra que le escribimos primero a un candidato.
 *
 * `last_inbound_at` se queda en NULL a propósito: nuestro mensaje no abre la ventana de servicio,
 * la abre su respuesta. Si aquí se pusiera `now()`, el bot creería que puede mandar texto libre y
 * Meta se lo rechazaría.
 */
export async function saveOutreach(waId: string, seed: SeedProvider, state: ConversationState): Promise<void> {
  if (!pool) {
    fallback().conversations.set(waId, { waId, providerId: seed.providerId, profileName: seed.displayName, lastInboundAtMs: null, state });
    return;
  }
  await query(
    `INSERT INTO marketplace.whatsapp_conversations (wa_id, provider_id, profile_name, last_outbound_at, state)
     VALUES ($1, $2, $3, now(), $4::jsonb)
     ON CONFLICT (wa_id) DO UPDATE SET last_outbound_at = now(), updated_at = now()`,
    [waId, seed.providerId, seed.displayName, JSON.stringify(state)],
  );
}

/** Un mensaje entrante: abre (o reabre) la ventana de 24h y guarda el avance. */
export async function saveInbound(waId: string, profileName: string | null, timestampMs: number, state: ConversationState): Promise<void> {
  if (!pool) {
    const existing = fallback().conversations.get(waId);
    fallback().conversations.set(waId, {
      waId,
      providerId: existing?.providerId ?? state.seed?.providerId ?? null,
      profileName: profileName ?? existing?.profileName ?? null,
      lastInboundAtMs: timestampMs,
      state,
    });
    return;
  }
  await query(
    `INSERT INTO marketplace.whatsapp_conversations (wa_id, provider_id, profile_name, last_inbound_at, state, finished)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5::jsonb, $6)
     ON CONFLICT (wa_id) DO UPDATE SET
       last_inbound_at = EXCLUDED.last_inbound_at,
       -- Una simulación reinicia la conversación con otro proveedor: la fila tiene que seguirla.
       provider_id = COALESCE(EXCLUDED.provider_id, marketplace.whatsapp_conversations.provider_id),
       profile_name = COALESCE(EXCLUDED.profile_name, marketplace.whatsapp_conversations.profile_name),
       state = EXCLUDED.state,
       finished = EXCLUDED.finished,
       updated_at = now()`,
    [waId, state.seed?.providerId ?? null, profileName, timestampMs, JSON.stringify(state), state.finished],
  );
}

export async function saveState(waId: string, state: ConversationState): Promise<void> {
  if (!pool) {
    const existing = fallback().conversations.get(waId);
    if (existing) existing.state = state;
    return;
  }
  await query(
    `UPDATE marketplace.whatsapp_conversations
     SET state = $2::jsonb, finished = $3, last_outbound_at = now(), updated_at = now()
     WHERE wa_id = $1`,
    [waId, JSON.stringify(state), state.finished],
  );
}

/**
 * Meta reintenta el webhook cuando no recibe un 200 a tiempo, así que el mismo mensaje llega varias
 * veces. El `INSERT` con clave primaria es el que decide: si no inserta, ya lo habíamos visto.
 */
export async function isDuplicate(messageId: string, waId: string, body: string, providerId?: string | null): Promise<boolean> {
  if (!pool) {
    if (fallback().messages.has(messageId)) return true;
    fallback().messages.add(messageId);
    return false;
  }
  const result = await query<{ message_id: string }>(
    `INSERT INTO marketplace.whatsapp_messages (message_id, wa_id, direction, body)
     VALUES ($1, $2, 'in', $3)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
    [messageId, waId, body.slice(0, 4000)],
  );
  return result.rows.length === 0;
}

export async function recordOutboundMessage(waId: string, body: string, providerId?: string | null): Promise<void> {
  if (!pool) return;
  await query(
    `INSERT INTO marketplace.whatsapp_messages (message_id, wa_id, direction, body)
     VALUES ($1, $2, 'out', $3) ON CONFLICT (message_id) DO NOTHING`,
    [`out:${waId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, waId, body.slice(0, 4000)],
  );
}

export async function isSuppressed(waId: string): Promise<boolean> {
  if (!pool) return fallback().suppressed.has(waId);
  const result = await query<{ wa_id: string }>('SELECT wa_id FROM marketplace.whatsapp_suppressions WHERE wa_id = $1', [waId]);
  return result.rows.length > 0;
}

/** Quien pide que no le escribamos entra aquí, y `startOutreach` lo consulta antes de nada. */
export async function suppress(waId: string, reason: string, source: string): Promise<void> {
  if (!pool) {
    fallback().suppressed.add(waId);
    return;
  }
  await query(
    `INSERT INTO marketplace.whatsapp_suppressions (wa_id, reason, source)
     VALUES ($1, $2, $3) ON CONFLICT (wa_id) DO NOTHING`,
    [waId, reason.slice(0, 300), source],
  );
}

/**
 * Cuántos contactos salieron hoy.
 *
 * Meta asigna un cupo diario que sube o baja según la calidad de la cuenta, y gastarlo de golpe el
 * primer día es la forma rápida de que lo bajen. Se cuenta sobre conversaciones creadas hoy, que es
 * exactamente una por número contactado.
 */
/**
 * Invitaciones enviadas en las últimas 24 horas, que es como mide Meta su cupo.
 *
 * Cuenta por proveedor (`whatsapp_sent_at`) y no por conversación: en modo prueba todas las
 * invitaciones llegan al mismo número y comparten conversación, y el cupo tiene que seguir contando.
 */
export async function countOutreachToday(): Promise<number> {
  if (!pool) return 0;
  const result = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM marketplace.providers WHERE whatsapp_sent_at >= now() - interval '24 hours'`,
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * Deja la conversación de un número lista para un contacto nuevo, aunque ya existiera.
 *
 * A diferencia de `saveOutreach`, reemplaza el estado: en modo prueba cada invitación llega al mismo
 * número, y la conversación tiene que pasar a ser la del último proveedor al que se le escribió.
 */
export async function startConversation(waId: string, seed: SeedProvider, state: ConversationState): Promise<void> {
  if (!pool) {
    fallback().conversations.set(waId, { waId, providerId: seed.providerId, profileName: seed.displayName, lastInboundAtMs: null, state });
    return;
  }
  await query(
    `INSERT INTO marketplace.whatsapp_conversations (wa_id, provider_id, profile_name, last_outbound_at, state, finished)
     VALUES ($1, $2, $3, now(), $4::jsonb, false)
     ON CONFLICT (wa_id) DO UPDATE SET
       provider_id = EXCLUDED.provider_id, state = EXCLUDED.state, finished = false,
       last_outbound_at = now(), updated_at = now()`,
    [waId, seed.providerId, seed.displayName, JSON.stringify(state)],
  );
}

/** Conversaciones abiertas que llevan tiempo sin avanzar; candidatas a un recordatorio. */
export async function getStaleConversations(hours = 20): Promise<StoredConversation[]> {
  if (!pool) return [];
  const result = await query<{ wa_id: string; provider_id: string | null; profile_name: string | null; last_inbound_at: Date | null; state: ConversationState }>(
    `SELECT wa_id, provider_id, profile_name, last_inbound_at, state
     FROM marketplace.whatsapp_conversations
     WHERE finished = false
       AND last_inbound_at IS NOT NULL
       AND last_inbound_at < now() - ($1 || ' hours')::interval
     ORDER BY last_inbound_at ASC
     LIMIT 50`,
    [String(hours)],
  );
  return result.rows.map((row) => ({
    waId: row.wa_id,
    providerId: row.provider_id,
    profileName: row.profile_name,
    lastInboundAtMs: row.last_inbound_at ? row.last_inbound_at.getTime() : null,
    state: row.state ?? { draft: {}, finished: false },
  }));
}
