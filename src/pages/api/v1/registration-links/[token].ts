import type { APIRoute } from 'astro';
import { getRegistrationLink } from '../../../../lib/registration-link';
import { assertServiceAuth, json } from '../../../../lib/api-auth';

export const GET: APIRoute = async ({ request, params }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;
  return json(await getRegistrationLink(params.token ?? ''));
};
