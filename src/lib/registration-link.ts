import { pool, query } from './db';
import { hashToken } from './tracking';
import { REGISTRATION_CATEGORIES, type RegistrationLink } from './contract';

const DEFAULT_PROVIDER_NAME = 'tu negocio de eventos';

/**
 * Resuelve el estado de un enlace de registro a partir de su token opaco.
 *
 * El token se busca por hash: `hashToken` usa `node:crypto`, que no existe en el navegador ni en un
 * runtime edge. Esta resolución tiene que quedarse del lado del servidor aunque la página que la
 * consume se sirva desde otro sitio.
 */
export async function getRegistrationLink(token: string): Promise<RegistrationLink> {
  const base: RegistrationLink = {
    providerName: DEFAULT_PROVIDER_NAME,
    linkState: 'valid',
    submittedAt: null,
    categories: REGISTRATION_CATEGORIES,
  };

  if (!pool || !token) return base;

  try {
    const result = await query<{
      display_name: string | null;
      token_expires_at: Date | null;
      form_submitted_at: Date | null;
    }>(
      `SELECT p.display_name, cs.token_expires_at, cs.form_submitted_at
       FROM marketplace.campaign_sends cs
       LEFT JOIN marketplace.providers p ON p.provider_id = cs.provider_id
       WHERE cs.tracking_token_hash = $1
       LIMIT 1`,
      [hashToken(token)],
    );

    const row = result.rows[0];
    if (!row) return { ...base, linkState: 'unknown' };

    const providerName = row.display_name ?? DEFAULT_PROVIDER_NAME;
    if (row.form_submitted_at) {
      return { ...base, providerName, linkState: 'submitted', submittedAt: row.form_submitted_at.toISOString() };
    }
    // Un `token_expires_at` nulo es un envío anterior a la migración: se deja pasar.
    if (row.token_expires_at && row.token_expires_at.getTime() < Date.now()) {
      return { ...base, providerName, linkState: 'expired' };
    }
    return { ...base, providerName };
  } catch {
    // Un fallo de base no debe convertir un enlace bueno en uno roto: la página sigue mostrando el
    // formulario y el envío se validará igual del lado del servidor.
    return base;
  }
}
