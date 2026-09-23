import type { APIRoute } from 'astro';
import { harvestCategoryCandidates, hasHarvestQueries, isContactable, isGooglePlacesConfiguredForHarvest } from '../../../lib/places-harvest';
import { harvestToCurationTsv, harvestedPlaceToRow } from '../../../lib/harvest-import';
import { CURATION_HEADERS } from '../../../lib/curation';
import { verifyHarvestedCandidates } from '../../../lib/harvest-verify';
import { getPlacesUsage, placesBlockReason } from '../../../lib/places-gate';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * Cosecha candidatos desde Google Places para revisarlos antes de importar.
 *
 * Sin `placeIds` devuelve la lista para que el operador escoja; con `placeIds` devuelve el TSV solo
 * de los marcados. La segunda llamada vuelve a consultar Places en vez de fiarse de lo que mande el
 * navegador: la reputación que acaba en la base de datos tiene que venir de la API, no del cliente.
 */
export const POST: APIRoute = async ({ request }) => {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'El cuerpo de la solicitud no es válido.' }, 400);
  }

  const city = String(payload.city ?? '').trim();
  const category = String(payload.category ?? '').trim();
  if (!city) return json({ ok: false, error: 'Falta la ciudad.' }, 400);
  if (!hasHarvestQueries(category)) return json({ ok: false, error: 'La categoría no tiene consultas de cosecha definidas.' }, 400);
  if (!isGooglePlacesConfiguredForHarvest()) {
    // El motivo se dice tal cual: una clave presente sin opt-in es la situacion normal, no un fallo.
    const reason = placesBlockReason();
    const message = reason === 'not_configured'
      ? 'GOOGLE_PLACES_API_KEY no está configurada.'
      : reason === 'kill_switch'
        ? 'Google Places está apagado por el interruptor de emergencia (GOOGLE_PLACES_KILL_SWITCH).'
        : reason === 'limit_reached'
          ? 'Google Places agotó el tope de solicitudes de hoy (GOOGLE_PLACES_MAX_REQUESTS).'
          : 'Google Places está desactivado: la cosecha directa requiere GOOGLE_PLACES_OPT_IN=1 (cada consulta se factura como SKU Enterprise).';
    return json({ ok: false, error: message, reason, places: getPlacesUsage() }, 503);
  }

  try {
    const harvest = await harvestCategoryCandidates(city, category);

    const selected = Array.isArray(payload.placeIds)
      ? new Set(payload.placeIds.filter((id): id is string => typeof id === 'string'))
      : undefined;

    if (selected) {
      const chosen = harvest.candidates.filter(place => selected.has(place.placeId));
      if (!chosen.length) return json({ ok: false, error: 'Ninguno de los proveedores marcados sigue disponible en Places.' }, 409);

      // Paso opcional: el agente confirma pertinencia y busca correo e Instagram de ESTOS
      // negocios. No descubre nada, y por eso no puede colar proveedores que nadie pidio.
      const wantsVerification = payload.verify === true;
      let verification: Awaited<ReturnType<typeof verifyHarvestedCandidates>>['byPlaceId'] | undefined;
      let verificationStats: Record<string, unknown> | null = null;
      if (wantsVerification) {
        const outcome = await verifyHarvestedCandidates({ city, category, candidates: chosen });
        verification = outcome.byPlaceId;
        verificationStats = {
          verificados: outcome.verified,
          pertinentes: outcome.relevant,
          conCorreo: outcome.withEmail,
          conInstagram: outcome.withInstagram,
          durationMs: outcome.durationMs,
          error: outcome.failureReason ?? null,
        };
      }

      const lines: string[] = [CURATION_HEADERS.join('\t')];
      let index = 1;
      let skipped = 0;
      let unconfirmed = 0;
      for (const place of chosen) {
        const verified = verification?.get(place.placeId);
        // La fila entra igualmente: el juicio del agente sobre pertinencia no es fiable como para
        // borrar un proveedor sin que nadie lo vea. Queda anotada para revision humana.
        if (verified && !verified.relevant) unconfirmed += 1;
        const row = harvestedPlaceToRow(place, city, category, index, { verification });
        if (!row) { skipped += 1; continue; }
        lines.push(row.join('\t'));
        index += 1;
      }
      return json({
        ok: true, tsv: lines.join('\n'), rows: lines.length - 1,
        skipped, unconfirmed, requested: chosen.length, verification: verificationStats,
      });
    }

    const { rows, skipped } = harvestToCurationTsv(harvest);
    return json({
      ok: true,
      city,
      category,
      apiCalls: harvest.apiCalls,
      durationMs: harvest.durationMs,
      generatedRows: rows,
      skipped,
      candidates: harvest.candidates.map(place => ({
        placeId: place.placeId,
        name: place.name,
        type: place.type ?? null,
        rating: place.rating ?? null,
        reviews: place.reviews ?? null,
        phone: place.phone ?? null,
        website: place.website ?? null,
        mapsUrl: place.mapsUrl ?? null,
        address: place.address ?? null,
        contactable: isContactable(place),
        // Cumple el umbral de curaduría por sí solo. No dice nada sobre si el negocio realmente
        // presta el servicio de la categoría: eso es lo que toca revisar en pantalla.
        meetsThreshold: typeof place.rating === 'number' && place.rating >= 4.5
          && typeof place.reviews === 'number' && place.reviews >= 30,
      })),
    });
  } catch (error) {
    console.error('Harvest endpoint failed', error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'No se pudo completar la cosecha.' }, 502);
  }
};
