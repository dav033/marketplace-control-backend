import type { APIRoute } from 'astro';
import { importCurationTsv } from '../../../lib/provider-import';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

export const POST: APIRoute = async ({ request }) => {
  const contentType = request.headers.get('content-type') ?? '';
  let payload: Record<string, unknown>;
  try {
    payload = contentType.includes('application/json')
      ? await request.json() as Record<string, unknown>
      : Object.fromEntries((await request.formData()).entries());
  } catch {
    return json({ ok: false, accepted: 0, rejected: 0, error: 'El cuerpo de la solicitud no es válido.' }, 400);
  }
  const raw = typeof payload === 'object' && payload !== null && typeof payload.tsv === 'string' ? payload.tsv : '';
  const result = await importCurationTsv(raw);
  return json(result.body, result.status);
};
