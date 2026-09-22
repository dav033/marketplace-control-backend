import type { APIRoute } from 'astro';
import { createCity, listCities } from '../../../lib/cities';
import { assertServiceAuth, json } from '../../../lib/api-auth';

/** Ciudades del marketplace, con cuántos proveedores tienen y cuántos faltan por anunciar. */
export const GET: APIRoute = async ({ request }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;
  return json({ ok: true, cities: await listCities() });
};

export const POST: APIRoute = async ({ request }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;

  let payload: { name?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ ok: false, error: 'BODY_NOT_JSON' }, 400);
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) return json({ ok: false, error: 'NAME_REQUIRED' }, 400);

  const city = await createCity(name);
  return city === 'ALREADY_EXISTS'
    ? json({ ok: false, error: 'ALREADY_EXISTS' }, 409)
    : json({ ok: true, city }, 201);
};
