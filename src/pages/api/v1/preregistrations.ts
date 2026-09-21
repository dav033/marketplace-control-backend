import type { APIRoute } from 'astro';
import { getPreregistered } from '../../../lib/data';
import { assertServiceAuth, json } from '../../../lib/api-auth';

export const GET: APIRoute = async ({ request }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;
  return json({ providers: await getPreregistered() });
};
