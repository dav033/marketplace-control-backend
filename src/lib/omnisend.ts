type JsonRecord = Record<string, unknown>;

const env = (name: string) => import.meta.env[name as keyof ImportMetaEnv] ?? process.env[name];
const API_BASE = 'https://api.omnisend.com/api';

export function isOmnisendConfigured() {
  return Boolean(env('OMNISEND_API_KEY'));
}

function parseQaRecipients(value: string | undefined) {
  return [...new Set((value || '').split(',').map((recipient) => recipient.trim().toLowerCase()).filter(Boolean))];
}

export const QA_TEST_RECIPIENTS = parseQaRecipients(env('QA_TEST_RECIPIENTS') || env('QA_TEST_RECIPIENT') || 'david.theran03@gmail.com');

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = env('OMNISEND_API_KEY');
  if (!apiKey) throw new Error('OMNISEND_NOT_CONFIGURED');

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Omnisend-API-Key ${apiKey}`,
      'content-type': 'application/json',
      'Omnisend-Version': env('OMNISEND_VERSION') || '2026-03-15',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    console.error('Omnisend request failed', response.status, body);
    throw new Error(`OMNISEND_REQUEST_${response.status}`);
  }
  return body as T;
}

export type ConsentedContact = {
  consentGranted: true;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  customProperties?: Record<string, string | number | boolean | null>;
  /** POST /contacts es síncrono y acepta tags en la misma llamada: no hace falta un paso aparte. */
  tags?: string[];
};

/**
 * Omnisend rechaza con 400 cualquier `statusChangedAt` que no esté estrictamente en el pasado según
 * *su* reloj, y `new Date()` a secas caía justo en el borde: el envío entero moría con
 * `invalid_value: 'statusChangedAt' must not be in the future`. Un minuto de margen absorbe el
 * desfase entre relojes sin falsear la marca de consentimiento de forma apreciable.
 */
const CONSENT_CLOCK_SKEW_MS = 60_000;
function consentTimestamp() {
  return new Date(Date.now() - CONSENT_CLOCK_SKEW_MS).toISOString();
}

export async function upsertConsentedContact(input: ConsentedContact) {
  if (input.consentGranted !== true) throw new Error('OMNISEND_CONSENT_REQUIRED');
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('OMNISEND_EMAIL_INVALID');

  const customProperties = Object.fromEntries(
    Object.entries(input.customProperties || {}).filter(([, value]) => value !== null && value !== undefined),
  ) as JsonRecord;

  return request<JsonRecord>('/contacts', {
    method: 'POST',
    body: JSON.stringify({
      firstName: input.firstName?.trim() || undefined,
      lastName: input.lastName?.trim() || undefined,
      tags: input.tags?.length ? input.tags : undefined,
      identifiers: [{
        type: 'email',
        id: email,
        channels: { email: { status: 'subscribed', statusChangedAt: consentTimestamp() } },
      }],
      customProperties,
    }),
  });
}

/**
 * Crea un segmento dinámico filtrando por un tag exacto. Se usa un tag único por envío
 * (`send-<campaign_id>`) para que el segmento incluya exactamente el lote de esta campaña y nada más.
 */
export async function createTagSegment(input: { name: string; tag: string }): Promise<{ segmentID: string; status: string }> {
  return request<{ segmentID: string; status: string }>('/segments', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name.slice(0, 256),
      conditionGroups: [{
        conditions: [{
          entity: 'contact',
          junction: 'and',
          filters: [{ operator: 'anyOf', property: 'tags', value: [input.tag] }],
        }],
      }],
    }),
  });
}

export async function getSegment(segmentId: string): Promise<{ segmentID: string; status: 'building' | 'ready' | 'archived' }> {
  return request<{ segmentID: string; status: 'building' | 'ready' | 'archived' }>(`/segments/${segmentId}`);
}

/**
 * Un segmento nuevo pasa por `building` mientras Omnisend calcula su membresía; solo en `ready` es
 * seguro asumir que ya incluye los contactos recién etiquetados. Sin esta espera, la campaña real
 * podría lanzarse a una audiencia vacía o incompleta.
 */
export async function waitForSegmentReady(segmentId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const segment = await getSegment(segmentId);
    if (segment.status === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('OMNISEND_SEGMENT_NOT_READY');
}

export type CampaignStatistics = { delivered: number; opened: number; clicked: number; bounced: number };

/** Límite documentado: 10 solicitudes/minuto y 55/24h. Llamar solo bajo demanda, nunca en cada carga de página. */
export async function getCampaignStatistics(campaignId: string): Promise<CampaignStatistics> {
  const body = await request<{ statistics: Array<{ rows: Array<Record<string, number>> }> }>('/analytics/statistics', {
    method: 'POST',
    body: JSON.stringify({
      queries: [{
        alias: 'campaign_stats',
        dateRange: { from: '2020-01-01T00:00:00Z', to: new Date().toISOString() },
        dimensions: [],
        metrics: [{ name: 'delivered' }, { name: 'opened' }, { name: 'clicked' }, { name: 'bounced' }],
        filters: [{ name: 'campaignId', operator: 'equals', values: [campaignId] }],
      }],
    }),
  });
  const row = body.statistics?.[0]?.rows?.[0] ?? {};
  return {
    delivered: Number(row.delivered) || 0,
    opened: Number(row.opened) || 0,
    clicked: Number(row.clicked) || 0,
    bounced: Number(row.bounced) || 0,
  };
}

export async function createEmailCampaignDraft(input: {
  name: string;
  subject: string;
  senderName: string;
  senderEmail?: string;
  templateId: string;
  segmentIds?: string[];
}) {
  return request<JsonRecord>('/campaigns', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      type: 'regular',
      channel: 'email',
      language: 'es_LA',
      content: {
        email: {
          subject: input.subject,
          senderName: input.senderName,
          senderEmail: input.senderEmail,
          templateID: input.templateId,
        },
      },
      audience: input.segmentIds?.length ? { includedSegmentIDs: input.segmentIds } : undefined,
    }),
  });
}

export async function importEmailTemplate(input: { name: string; html: string }) {
  return request<JsonRecord>('/email-templates/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function sendEmailCampaignTest(campaignId: string, recipients: string[]) {
  if (!/^[0-9a-f]{24}$/i.test(campaignId)) throw new Error('OMNISEND_CAMPAIGN_ID_INVALID');
  if (recipients.length < 1 || recipients.length > 5) throw new Error('OMNISEND_TEST_RECIPIENTS_INVALID');
  return request<void>(`/campaigns/${campaignId}/test-email`, {
    method: 'POST',
    body: JSON.stringify({ recipients }),
  });
}

export async function sendEmailCampaign(campaignId: string) {
  if (!/^[0-9a-f]{24}$/i.test(campaignId)) throw new Error('OMNISEND_CAMPAIGN_ID_INVALID');
  return request<void>(`/campaigns/${campaignId}/send`, { method: 'POST' });
}
