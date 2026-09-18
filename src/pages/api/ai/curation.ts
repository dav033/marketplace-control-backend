import type { APIRoute } from 'astro';
import { curateProviders } from '../../../lib/gemini';
import { importCurationTsv } from '../../../lib/provider-import';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

export const POST: APIRoute = async ({ request }) => {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'El cuerpo de la solicitud no es JSON válido.' }, 400);
  }

  if (payload.action === 'import') {
    if (typeof payload.tsv !== 'string' || !payload.tsv.trim()) return json({ ok: false, error: 'Falta el lote TSV para importar.' }, 400);
    const result = await importCurationTsv(payload.tsv);
    return json(result.body, result.status);
  }

  const city = typeof payload.city === 'string' ? payload.city : '';
  const category = typeof payload.category === 'string' ? payload.category : '';
  const instructions = typeof payload.instructions === 'string' ? payload.instructions : undefined;
  if (!city.trim() || !category.trim()) return json({ ok: false, error: 'Ciudad y categoría son obligatorias.' }, 400);

  try {
    const result = await curateProviders({ city, category, instructions });
    return json({ ok: true, ...result, rejectedRows: result.rejectedRows.map(row => ({ line: row.line, id: row.rawCells[0] ?? null, issues: row.issues.map(({ code, message }) => ({ code, message })) })) });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'GEMINI_REQUEST_FAILED';
    const status = code === 'GEMINI_NOT_CONFIGURED' ? 503 : code === 'CITY_AND_CATEGORY_REQUIRED' ? 400 : 502;
    return json({ ok: false, error: code }, status);
  }
};
