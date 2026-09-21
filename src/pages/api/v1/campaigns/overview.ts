import type { APIRoute } from 'astro';
import { getCampaignOverview } from '../../../../lib/campaign-overview';
import { assertServiceAuth, json } from '../../../../lib/api-auth';

export const GET: APIRoute = async ({ request }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;
  return json(await getCampaignOverview());
};
