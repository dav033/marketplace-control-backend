import type { APIRoute } from 'astro';
import { getOutreachSeeds } from '../../../lib/data';
import { dailyLimit, startOutreachBatch, type BatchOutreachResult } from '../../../lib/whatsapp-outreach';
import { countOutreachToday } from '../../../lib/whatsapp-store';
import { isWhatsappConfigured, normalizeTestNumber, redirectTarget, testNumbers } from '../../../lib/whatsapp';

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Dispara el contacto saliente por WhatsApp, uno o en lote desde la tabla de proveedores.
 *
 * No es pública: el middleware solo abre la ruta exacta del webhook, y aquí hace falta la sesión del
 * panel (el frontend añade el token de servicio) o el Basic Auth del operador. Exige `confirm: true`,
 * igual que el envío de campañas por correo: manda mensajes reales y no puede salir por un clic
 * accidental ni por una petición perdida.
 */

/** Más de esto por llamada es otra cosa que un envío desde el panel; el panel manda tandas de 50. */
const MAX_PER_REQUEST = 50;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Lo que el panel enseña antes de disparar nada: cupo, si se puede enviar y si está en modo prueba. */
export const GET: APIRoute = async () => {
  const limite = dailyLimit();
  const enviados = await countOutreachToday();
  return json({
    ok: true,
    limite,
    enviados,
    disponibles: Math.max(0, limite - enviados),
    configurado: isWhatsappConfigured(),
    plantilla: env('WHATSAPP_OUTREACH_TEMPLATE') || null,
    redirigidoA: redirectTarget(),
    numerosPrueba: testNumbers(),
  });
};

export const POST: APIRoute = async ({ request }) => {
  let payload: { providerIds?: unknown; confirm?: unknown; testNumber?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ ok: false, error: 'BODY_NOT_JSON' }, 400);
  }

  if (payload.confirm !== true) return json({ ok: false, error: 'CONFIRMATION_REQUIRED' }, 400);

  const ids = Array.isArray(payload.providerIds)
    ? [...new Set(payload.providerIds.filter((id): id is string => typeof id === 'string'))]
    : [];
  if (!ids.length) return json({ ok: false, error: 'PROVIDERS_REQUIRED' }, 400);
  if (ids.length > MAX_PER_REQUEST) return json({ ok: false, error: 'TOO_MANY_PROVIDERS' }, 400);

  // El número de prueba solo puede ser uno de la lista del servidor: el panel elige entre ellos,
  // nunca manda a un número cualquiera.
  // En modo prueba, quien envía puede escribir cualquier teléfono, no solo los de la lista del
  // servidor: es su propio teléfono de pruebas. Fuera de modo prueba no se redirige nada.
  const testNumber = typeof payload.testNumber === 'string' && payload.testNumber.trim() ? payload.testNumber.trim() : undefined;
  if (testNumber) {
    if (!testNumbers().length) return json({ ok: false, error: 'TEST_MODE_OFF' }, 400);
    if (!normalizeTestNumber(testNumber)) return json({ ok: false, error: 'INVALID_TEST_NUMBER' }, 400);
  }

  // Los datos del candidato salen de la base, no del navegador: quien llama elige A QUIÉN se
  // escribe, nunca QUÉ se le escribe ni con qué teléfono.
  const filas = await getOutreachSeeds(ids);
  const encontrados = new Set(filas.map((fila) => fila.provider_id));

  const resultado: BatchOutreachResult = await startOutreachBatch(filas.map((fila) => ({
    providerId: fila.provider_id,
    displayName: fila.display_name,
    city: fila.city,
    category: fila.category,
    additionalCategories: fila.additional_categories ?? [],
    phone: fila.phone,
    email: fila.contact_email,
    whatsappStatus: fila.whatsapp_status,
  })), { testNumber });

  // Los ids que no existen se devuelven igual, para que el panel pueda decir cuáles fallaron.
  const noEncontrados = ids
    .filter((id) => !encontrados.has(id))
    .map((id) => ({ providerId: id, displayName: '', outcome: { ok: false as const, reason: 'NOT_FOUND' as const } }));

  return json({ ok: true, sent: resultado.sent, results: [...resultado.results, ...noEncontrados] }, 201);
};
