/**
 * Punto de entrada público del flujo de registro conversacional.
 *
 * La implementación (tipos, validaciones, la máquina de XState y `advance`/`nextStep`) vive en
 * `registration-machine.ts`. Este archivo solo re-exporta, para que nada de lo que ya importaba
 * `./registration-chat` — `conversation-runner.ts`, `conversation-agent.ts`, `whatsapp-outreach.ts`, los
 * scripts de prueba — tenga que cambiar una sola línea.
 */
export * from './registration-machine';
