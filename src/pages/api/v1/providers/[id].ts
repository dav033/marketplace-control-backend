import type { APIRoute } from 'astro';
import { deleteProvider, getProvider } from '../../../../lib/data';
import { assertServiceAuth, json } from '../../../../lib/api-auth';

export const GET: APIRoute = async ({ request, params }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;
  const provider = await getProvider(params.id ?? '');
  if (!provider) return json({ ok: false, error: 'PROVIDER_NOT_FOUND' }, 404);
  return json(provider);
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;
  const deleted = await deleteProvider(params.id ?? '');
  if (!deleted) return json({ ok: false, error: 'PROVIDER_NOT_FOUND' }, 404);
  return json({ ok: true });
};
