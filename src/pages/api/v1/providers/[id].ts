import type { APIRoute } from 'astro';
import { deleteProvider, getProvider } from '../../../../lib/data';
import { assertServiceAuth, json } from '../../../../lib/api-auth';
import { setProviderCategories } from '../../../../lib/data';

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

/** Editar las categorías del proveedor desde su ficha. */
export const PATCH: APIRoute = async ({ request, params }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;

  let payload: { category?: unknown; additionalCategories?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ ok: false, error: 'BODY_NOT_JSON' }, 400);
  }

  const result = await setProviderCategories(params.id ?? '', {
    category: typeof payload.category === 'string' ? payload.category : undefined,
    additionalCategories: Array.isArray(payload.additionalCategories)
      ? payload.additionalCategories.filter((item): item is string => typeof item === 'string')
      : undefined,
  });
  if (result === 'INVALID') return json({ ok: false, error: 'CATEGORIES_INVALID' }, 400);
  return result ? json({ ok: true, ...result }) : json({ ok: false, error: 'NOT_FOUND' }, 404);
};
