/**
 * La regla de la ventana de servicio de 24h.
 *
 * Desde que el proveedor escribe, hay 24h para responder con mensajes libres. Pasadas, solo entra
 * una plantilla aprobada. No es una optimizacion: es lo que decide si un envio sale o lo rechaza
 * la API de Meta.
 *
 * El ESTADO de las conversaciones ya no vive aqui sino en `whatsapp-store.ts`, contra PostgreSQL.
 * Estaba en un Map en memoria y un reinicio del servidor borraba todas las conversaciones a medias.
 */

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Abierta = se puede responder con texto libre. Cerrada = solo plantilla aprobada. */
export function isWindowOpen(lastInboundAtMs: number | null, now = Date.now()): boolean {
  if (lastInboundAtMs === null) return false;
  return now - lastInboundAtMs < SERVICE_WINDOW_MS;
}

export function msLeftInWindow(lastInboundAtMs: number | null, now = Date.now()): number {
  if (lastInboundAtMs === null) return 0;
  return Math.max(0, lastInboundAtMs + SERVICE_WINDOW_MS - now);
}
