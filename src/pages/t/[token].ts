import type { APIRoute } from 'astro';
import { query, pool } from '../../lib/db';
import { hashToken } from '../../lib/tracking';

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

export const GET: APIRoute = async ({ params, request, redirect }) => {
  const token = params.token ?? '';
  if (pool) {
    try {
      const send = await query<{ send_id: string }>(`SELECT send_id FROM marketplace.campaign_sends WHERE tracking_token_hash = $1 LIMIT 1`, [hashToken(token)]);
      if (send.rows[0]) await query(`INSERT INTO marketplace.email_clicks (send_id, link_key, ip_hash, user_agent_hash) VALUES ($1,'registration',$2,$3)`, [send.rows[0].send_id, hashToken(request.headers.get('x-forwarded-for') ?? 'unknown'), hashToken(request.headers.get('user-agent') ?? '')]);
    } catch (error) { console.error('Click tracking failed', error instanceof Error ? error.message : error); }
  }
  // El formulario ya NO vive en el backend: tras la separacion, `/registro/:token` lo sirve el
  // frontend. Un redirect relativo dejaria al proveedor en un 404 del dominio del backend, que es
  // el que aparece en el enlace del correo. Sin `FRONTEND_URL` se mantiene el comportamiento
  // antiguo, que es el correcto mientras las dos partes compartan dominio.
  const destino = (env('FRONTEND_URL') || env('APP_URL') || '').replace(/\/$/, '');
  const ruta = `/registro/${encodeURIComponent(token)}`;
  return redirect(destino ? `${destino}${ruta}` : ruta, 302);
};
