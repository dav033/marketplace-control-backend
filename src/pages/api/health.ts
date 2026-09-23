import { getPlacesUsage } from '../../lib/places-gate';

/** Estado del servicio y, con el, el uso de Google Places: cuantas peticiones se intentaron hoy,
 * cuantas salieron y cuantas se bloquearon, y por que. Es la forma rapida de comprobar desde fuera
 * que el backend no esta generando cargos. */
export const GET = () => new Response(
  JSON.stringify({ ok: true, service: 'marketplace-control', places: getPlacesUsage() }),
  { headers: { 'content-type': 'application/json' } },
);
