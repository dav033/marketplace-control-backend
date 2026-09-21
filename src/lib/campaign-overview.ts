import { pool, query } from './db';
import { isOmnisendConfigured, QA_TEST_RECIPIENTS } from './omnisend';
import type { CampaignOverview, CampaignRecipient, CampaignSummary } from './contract';

const env = (name: string) => import.meta.env[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Todo lo que necesita la pantalla de campañas, resuelto en el servidor.
 *
 * Las listas de ciudades, estados y categorías se calculan aquí y no en la página: son una
 * consecuencia del lote que devuelve la base, y dejarlas en el front obligaría a cada cliente a
 * reimplementar el mismo `Set` + `localeCompare`.
 */
export async function getCampaignOverview(): Promise<CampaignOverview> {
  const defaultSender = env('OMNISEND_SENDER_EMAIL') ?? '';
  const omnisendReady = isOmnisendConfigured();
  const qaRecipientsLabel = QA_TEST_RECIPIENTS.join(', ');

  if (!pool) {
    return {
      connected: false,
      campaigns: [],
      recipients: [],
      cities: [],
      statuses: [],
      categories: [],
      defaultSender,
      omnisendReady,
      qaRecipientsLabel,
      emailEligibleCount: 0,
      qaRecipientsCount: QA_TEST_RECIPIENTS.length,
    };
  }

  const campaigns = (await query<CampaignSummary>(`
    SELECT c.campaign_id, c.name, c.subject, c.status, c.sender_email, c.created_at,
           count(DISTINCT cs.send_id)::int AS recipients,
           count(DISTINCT cs.send_id) FILTER (WHERE cs.status = 'sent')::int AS sent,
           count(DISTINCT cs.send_id) FILTER (WHERE cs.status = 'failed')::int AS failed,
           count(DISTINCT ec.send_id)::int AS clicked,
           count(DISTINCT cs.send_id) FILTER (WHERE cs.form_submitted_at IS NOT NULL)::int AS forms,
           max(cs.provider_message_id) AS omnisend_campaign_id
    FROM marketplace.campaigns c
    LEFT JOIN marketplace.campaign_sends cs ON cs.campaign_id = c.campaign_id
    -- Un envío con varios clics cuenta una vez: la pregunta es cuántos destinatarios mostraron
    -- interés, no cuántas veces pulsaron.
    LEFT JOIN marketplace.email_clicks ec ON ec.send_id = cs.send_id
    GROUP BY c.campaign_id
    ORDER BY c.created_at DESC
    LIMIT 30
  `)).rows;

  const recipients = (await query<CampaignRecipient>(`
    SELECT p.provider_id, p.display_name, p.category, p.city, p.status, p.contact_channel, p.phone,
           c.contact_id, c.email, c.full_name, c.consent_status,
           (p.contact_channel = 'email' AND c.contact_id IS NOT NULL AND c.consent_status = 'granted' AND c.suppressed_at IS NULL) AS email_eligible
    FROM marketplace.providers p
    LEFT JOIN LATERAL (
      SELECT contact_id, email, full_name, consent_status, suppressed_at
      FROM marketplace.contacts
      WHERE provider_id = p.provider_id
      ORDER BY created_at DESC
      LIMIT 1
    ) c ON true
    WHERE p.status <> 'archived'
    ORDER BY p.city, p.category, p.display_name
    LIMIT 500
  `)).rows;

  const distinct = (values: Array<string | null | undefined>) =>
    [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'es'));

  return {
    connected: true,
    campaigns,
    recipients,
    cities: distinct(recipients.map((item) => item.city)),
    statuses: distinct(recipients.map((item) => item.status)),
    categories: distinct(recipients.map((item) => item.category)),
    defaultSender,
    omnisendReady,
    qaRecipientsLabel,
    emailEligibleCount: recipients.filter((item) => item.email_eligible).length,
    qaRecipientsCount: QA_TEST_RECIPIENTS.length,
  };
}
