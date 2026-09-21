import type { APIRoute } from 'astro';
import { query } from '../../../../lib/db';
import { getCampaignStatistics } from '../../../../lib/omnisend';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Bajo demanda únicamente: el endpoint de estadísticas de Omnisend permite 10 solicitudes/minuto y
// 55/24h por cuenta. No se debe llamar automáticamente al cargar la página.
export const GET: APIRoute = async ({ params }) => {
  const campaignId = params.campaignId ?? '';
  if (!uuidPattern.test(campaignId)) {
    return new Response(JSON.stringify({ ok: false, error: 'INVALID_CAMPAIGN_ID' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  try {
    const result = await query<{ provider_message_id: string | null }>(
      `SELECT max(provider_message_id) AS provider_message_id FROM marketplace.campaign_sends WHERE campaign_id = $1`,
      [campaignId],
    );
    const omnisendCampaignId = result.rows[0]?.provider_message_id;
    if (!omnisendCampaignId) throw new Error('OMNISEND_CAMPAIGN_NOT_FOUND');
    const stats = await getCampaignStatistics(omnisendCampaignId);
    return new Response(JSON.stringify({ ok: true, stats }), { headers: { 'content-type': 'application/json' } });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'STATS_FAILED';
    return new Response(JSON.stringify({ ok: false, error: code }), { status: code === 'OMNISEND_CAMPAIGN_NOT_FOUND' ? 404 : 500, headers: { 'content-type': 'application/json' } });
  }
};
