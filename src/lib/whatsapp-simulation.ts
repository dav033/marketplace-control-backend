import { getProvider } from './data';
import { outreachTranscript } from './whatsapp-outreach';
import { stateFromProvider, type ConversationState } from './conversation-runner';
import type { SeedProvider } from './registration-chat';

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Simulación de contacto saliente por WhatsApp, para probar desde el panel.
 *
 * El contacto real funciona así: el sistema le escribe primero al proveedor (la plantilla aprobada
 * por Meta) y el agente conversa cuando él contesta. Probar eso con un proveedor de verdad no es
 * opción, así que quien prueba manda `id: <proveedor>` desde su propio WhatsApp y el sistema le
 * responde como si le hubiera escrito primero a ese proveedor: el mismo texto de la invitación y el
 * mismo estado de conversación, con la ficha del negocio precargada. A partir de ahí, quien prueba
 * contesta en el papel del proveedor.
 *
 * Cualquier número puede simular, salvo que `WHATSAPP_SIMULATION_NUMBERS` lo restrinja a una lista
 * (o `off` lo desactive). Es seguro dejarlo abierto porque lo que sale de una simulación queda
 * marcado como tal: la ficha se guarda para poder revisarla, pero no cambia el estado del proveedor
 * real, y la invitación solo le llega a quien la pidió.
 */

/** Dígitos del número, que es como llega `wa_id` desde Meta. */
function digits(value: string) {
  return value.replace(/\D/g, '');
}

/** Sin configurar (o `*`), cualquiera; con una lista, solo esos números; `off`, nadie. */
export function simulationAllowed(waId: string): boolean {
  const configured = (env('WHATSAPP_SIMULATION_NUMBERS') ?? '').trim();
  if (!configured || configured === '*') return true;
  if (/^(off|no|false|0)$/i.test(configured)) return false;
  const allowed = configured.split(',').map(digits).filter(Boolean);
  return allowed.includes(digits(waId));
}

export type SimulationStart =
  | { ok: true; opening: string; state: ConversationState; seed: SeedProvider }
  | { ok: false; reason: 'NOT_ALLOWED' | 'PROVIDER_NOT_FOUND' };

/**
 * Prepara una simulación nueva: la conversación de ese número se reinicia con el proveedor elegido,
 * aunque ya viniera de otra prueba. Es lo que permite probar varios proveedores desde un teléfono.
 */
export async function startSimulation(
  waId: string,
  providerId: string,
  lookup: typeof getProvider = getProvider,
): Promise<SimulationStart> {
  if (!simulationAllowed(waId)) return { ok: false, reason: 'NOT_ALLOWED' };

  const provider = await lookup(providerId);
  if (!provider) return { ok: false, reason: 'PROVIDER_NOT_FOUND' };

  const seed: SeedProvider = {
    providerId: provider.provider_id,
    displayName: provider.display_name,
    city: provider.city,
    category: provider.category,
    additionalCategories: provider.additional_categories ?? [],
    phone: provider.phone,
    email: provider.contact_email,
  };
  const opening = outreachTranscript(seed);
  return {
    ok: true,
    opening,
    seed,
    state: { ...stateFromProvider(seed, opening), simulation: { startedAt: Date.now() } },
  };
}
