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
};

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
      identifiers: [{
        type: 'email',
        id: email,
        channels: { email: { status: 'subscribed', statusChangedAt: new Date().toISOString() } },
      }],
      customProperties,
    }),
  });
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
