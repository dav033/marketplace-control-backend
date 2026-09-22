/**
 * En qué punto está el contacto por WhatsApp con un proveedor.
 *
 * Se guarda en `providers.whatsapp_status` para que el panel sepa a quién ya se le escribió y cómo
 * va cada conversación, sin tener que leer los mensajes. Lo clasifica el agente con sus
 * herramientas (interés, no le interesa, comportamiento inadecuado) y el código decide la
 * transición: así un modelo no puede, por ejemplo, devolver a "iniciada" a alguien ya inscrito.
 */

import type { WhatsappStatus } from './types';

export type { WhatsappStatus };

export const WHATSAPP_STATUSES: readonly WhatsappStatus[] = [
  'mensaje_enviado',
  'conversacion_iniciada',
  'conversacion_aceptada',
  'conversacion_rechazada',
  'rechazado',
  'inscrito',
];

export type StatusEvent =
  /** Salió la plantilla de invitación. */
  | { type: 'sent' }
  /** El proveedor escribió algo. */
  | { type: 'inbound' }
  /** Mostró interés en seguir: contestó que sí, contó de su negocio, dio datos. */
  | { type: 'interest' }
  /** Dijo que no le interesa (o pidió que no le escribamos). */
  | { type: 'decline'; reason: string }
  /** Negó la autorización de datos: aceptó conversar pero no la inscripción. */
  | { type: 'consent_denied' }
  /** Insultos, provocaciones, insistir en listar algo prohibido. */
  | { type: 'inappropriate'; reason: string }
  /** La ficha quedó guardada. */
  | { type: 'registered' };

export type StatusChange = { status: WhatsappStatus | null; reason: string | null };

const ACCEPTED: ReadonlySet<WhatsappStatus | null> = new Set(['conversacion_aceptada', 'rechazado', 'inscrito']);

/**
 * La transición de estado ante un evento. Pura: recibe el estado actual y devuelve el siguiente.
 *
 * Las reglas que importan:
 * - "Rechazada" y "rechazado" no son lo mismo: decir que no ANTES de aceptar conversar es rechazar
 *   la conversación; decir que no DESPUÉS (o negar la autorización) es rechazar la inscripción.
 * - Un inscrito sigue inscrito aunque luego diga que no le interesa: esa baja la gestiona el equipo
 *   sobre su ficha. Solo un comportamiento inadecuado lo mueve.
 * - Volver a mostrar interés reabre: quien dijo que no y luego escribe "al final sí" pasa a aceptada.
 */
export function nextStatus(current: StatusChange, event: StatusEvent): StatusChange {
  const status = current.status;
  switch (event.type) {
    case 'sent':
      return status === null ? { status: 'mensaje_enviado', reason: null } : current;
    case 'inbound':
      return status === null || status === 'mensaje_enviado' ? { status: 'conversacion_iniciada', reason: null } : current;
    case 'interest':
      if (status === 'inscrito' || status === 'conversacion_aceptada') return current;
      // Tras un comportamiento inadecuado no se reabre solo por seguir escribiendo.
      if (status === 'rechazado' && current.reason?.startsWith('Comportamiento inadecuado')) return current;
      return { status: 'conversacion_aceptada', reason: null };
    case 'decline':
      if (status === 'inscrito') return current;
      return ACCEPTED.has(status)
        ? { status: 'rechazado', reason: event.reason }
        : { status: 'conversacion_rechazada', reason: event.reason };
    case 'consent_denied':
      if (status === 'inscrito') return current;
      return { status: 'rechazado', reason: 'No autorizó el tratamiento de sus datos' };
    case 'inappropriate':
      return { status: 'rechazado', reason: `Comportamiento inadecuado: ${event.reason}` };
    case 'registered':
      return { status: 'inscrito', reason: null };
  }
}

/** Aplica varios eventos seguidos, en orden. */
export function applyStatusEvents(current: StatusChange, events: StatusEvent[]): StatusChange {
  return events.reduce(nextStatus, current);
}

export const STATUS_LABELS: Record<WhatsappStatus, string> = {
  mensaje_enviado: 'mensaje enviado, sin respuesta todavía',
  conversacion_iniciada: 'conversación iniciada: contestó, pero aún no mostró interés claro',
  conversacion_aceptada: 'conversación aceptada: le interesa y está contando de su negocio',
  conversacion_rechazada: 'conversación rechazada: dijo que no le interesa',
  rechazado: 'rechazado: aceptó conversar pero no la inscripción, o se comportó de forma inadecuada',
  inscrito: 'inscrito: su ficha está guardada',
};
