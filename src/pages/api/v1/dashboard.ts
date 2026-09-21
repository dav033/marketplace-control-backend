import type { APIRoute } from 'astro';
import { getDashboard } from '../../../lib/data';
import { assertServiceAuth, json } from '../../../lib/api-auth';

export const GET: APIRoute = async ({ request }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;
  return json(await getDashboard());
};
