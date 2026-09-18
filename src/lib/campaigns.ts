import { randomBytes } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { pool, query } from './db';
import { hashToken } from './tracking';

type Recipient = { contact_id: string; provider_id: string | null; email: string; full_name: string | null; display_name: string | null };

const env = (name: string) => import.meta.env[name as keyof ImportMetaEnv] ?? process.env[name];
const escapeHtml = (value: string) => value.replace(/[&<>\"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[character] ?? character);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredEmail(value: string, label: string) {
  const email = value.trim().toLowerCase();
  if (!emailPattern.test(email) || email.length > 320) throw new Error(`${label}_INVALID`);
  return email;
}

function renderBody(template: string, recipient: Recipient, registrationUrl: string) {
  const name = recipient.full_name || recipient.display_name || 'equipo';
  const text = template.replaceAll('{{nombre}}', name).replaceAll('{{enlace_registro}}', registrationUrl).replaceAll('{{registro_url}}', registrationUrl);
  return { text, html: escapeHtml(text).replaceAll('\n', '<br>') };
}

export async function sendCampaign(input: { name: string; subject: string; bodyText: string; senderEmail?: string; replyToEmail?: string; contactIds: string[]; origin: string; confirm: boolean }) {
  if (!pool) throw new Error('DATABASE_NOT_CONFIGURED');
  if (!input.confirm) throw new Error('CONFIRMATION_REQUIRED');
  if (!input.name.trim() || !input.subject.trim() || !input.bodyText.trim()) throw new Error('CAMPAIGN_FIELDS_REQUIRED');
  if (!input.contactIds.length) throw new Error('NO_CONTACTS_SELECTED');
  if (input.contactIds.length > 100) throw new Error('TOO_MANY_CONTACTS');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const contactIds = [...new Set(input.contactIds)];
  if (contactIds.length !== input.contactIds.length || contactIds.some((contactId) => !uuidPattern.test(contactId))) throw new Error('INVALID_CONTACT_IDS');

  const sender = requiredEmail(input.senderEmail || env('SES_FROM_EMAIL') || '', 'SES_FROM_EMAIL');
  const configuredReplyTo = env('SES_REPLY_TO_EMAIL');
  const replyTo = input.replyToEmail ? requiredEmail(input.replyToEmail, 'SES_REPLY_TO_EMAIL') : configuredReplyTo ? requiredEmail(String(configuredReplyTo), 'SES_REPLY_TO_EMAIL') : undefined;
  const baseUrl = (env('APP_URL') || input.origin).replace(/\/$/, '');
  const client = await pool.connect();
  const queued: Array<Recipient & { send_id: string; token: string }> = [];

  try {
    await client.query('BEGIN');
    const recipients = await client.query<Recipient>(`SELECT c.contact_id, c.provider_id, c.email, c.full_name, p.display_name FROM marketplace.contacts c LEFT JOIN marketplace.providers p ON p.provider_id = c.provider_id WHERE c.contact_id = ANY($1::uuid[]) AND c.consent_status = 'granted' AND c.suppressed_at IS NULL ORDER BY c.email`, [contactIds]);
    if (!recipients.rows.length) throw new Error('NO_ELIGIBLE_CONTACTS');
    const campaign = await client.query<{ campaign_id: string }>(`INSERT INTO marketplace.campaigns (name, campaign_type, status, subject, body_text, sender_email, reply_to_email, ses_configuration_set, created_by) VALUES ($1,'marketing','sending',$2,$3,$4,$5,$6,'operator') RETURNING campaign_id`, [input.name.trim(), input.subject.trim(), input.bodyText.trim(), sender, replyTo ?? null, env('SES_CONFIGURATION_SET') || null]);
    for (const recipient of recipients.rows) {
      const token = randomBytes(32).toString('hex');
      const inserted = await client.query<{ send_id: string }>(`INSERT INTO marketplace.campaign_sends (campaign_id, contact_id, provider_id, status, tracking_token_hash) VALUES ($1,$2,$3,'sending',$4) ON CONFLICT (campaign_id, contact_id) DO NOTHING RETURNING send_id`, [campaign.rows[0].campaign_id, recipient.contact_id, recipient.provider_id, hashToken(token)]);
      if (inserted.rows[0]) queued.push({ ...recipient, send_id: inserted.rows[0].send_id, token });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    client.release();
    throw error;
  }
  client.release();

  const ses = new SESv2Client({ region: env('AWS_REGION') || 'us-east-1' });
  let sent = 0;
  let failed = 0;
  for (const recipient of queued) {
    const registrationUrl = `${baseUrl}/registro/${recipient.token}`;
    const rendered = renderBody(input.bodyText, recipient, registrationUrl);
    try {
      const response = await ses.send(new SendEmailCommand({ FromEmailAddress: sender, Destination: { ToAddresses: [recipient.email] }, ReplyToAddresses: replyTo ? [replyTo] : undefined, ConfigurationSetName: env('SES_CONFIGURATION_SET') || undefined, Content: { Simple: { Subject: { Data: input.subject.trim(), Charset: 'UTF-8' }, Body: { Text: { Data: rendered.text, Charset: 'UTF-8' }, Html: { Data: rendered.html, Charset: 'UTF-8' } } } } }));
      await query(`UPDATE marketplace.campaign_sends SET status = 'sent', ses_message_id = $1, sent_at = now(), last_event_at = now(), updated_at = now() WHERE send_id = $2`, [response.MessageId ?? null, recipient.send_id]);
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'SES_SEND_FAILED';
      await query(`UPDATE marketplace.campaign_sends SET status = 'failed', error_message = $1, last_event_at = now(), updated_at = now() WHERE send_id = $2`, [message, recipient.send_id]);
      failed += 1;
    }
  }
  const campaignId = await query<{ campaign_id: string }>(`SELECT campaign_id FROM marketplace.campaign_sends WHERE send_id = $1`, [queued[0].send_id]);
  await query(`UPDATE marketplace.campaigns SET status = 'completed', completed_at = now(), updated_at = now() WHERE campaign_id = $1`, [campaignId.rows[0]?.campaign_id]);
  return { campaignId: campaignId.rows[0]?.campaign_id ?? null, attempted: queued.length, sent, failed };
}
