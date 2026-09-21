import type { APIRoute } from 'astro';
import { getRegistration } from '../../../../lib/data';
import { assertServiceAuth, json } from '../../../../lib/api-auth';

export const GET: APIRoute = async ({ request, params }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;
  const registration = await getRegistration(params.id ?? '');
  if (!registration) return json({ ok: false, error: 'REGISTRATION_NOT_FOUND' }, 404);
  return json(registration);
};
