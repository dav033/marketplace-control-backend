-- Estado de las conversaciones de WhatsApp.
--
-- Con el correo el estado viaja en el token del enlace y el servidor no guarda nada entre medias.
-- Con WhatsApp los mensajes llegan sueltos al webhook, identificados solo por número, así que el
-- avance de cada conversación es responsabilidad nuestra: si no está aquí, no existe. Tenerlo en
-- memoria del proceso significaba que un deploy borraba todas las conversaciones a medias y el
-- proveedor recibía de nuevo el saludo inicial como si nunca hubiera escrito.

CREATE TABLE IF NOT EXISTS marketplace.whatsapp_conversations (
  wa_id text PRIMARY KEY,
  provider_id uuid REFERENCES marketplace.providers(provider_id) ON DELETE SET NULL,
  profile_name text,
  -- NULL significa que todavía no ha contestado: la ventana de servicio está cerrada y solo se le
  -- puede escribir con plantilla aprobada. Es el dato que decide si un envío sale o lo rechaza Meta.
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  -- Borrador del registro y datos del candidato, tal como los maneja el motor de conversación.
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  finished boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Para contar cuántos contactos salieron hoy sin recorrer la tabla entera.
CREATE INDEX IF NOT EXISTS whatsapp_conversations_created_idx
  ON marketplace.whatsapp_conversations (created_at DESC);

-- Mensajes vistos. Meta reintenta el webhook cuando no recibe un 200 a tiempo, y sin esto el mismo
-- mensaje se contestaba dos veces y se pagaba el modelo dos veces. En memoria se perdía al
-- reiniciar, justo cuando más reintentos hay.
CREATE TABLE IF NOT EXISTS marketplace.whatsapp_messages (
  message_id text PRIMARY KEY,
  wa_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  body text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_messages_wa_idx
  ON marketplace.whatsapp_messages (wa_id, occurred_at DESC);

-- Quién pidió que no le escribamos más. Se consulta ANTES de cualquier contacto saliente: insistir
-- a quien dijo que no es lo que hace que Meta baje la calidad de la cuenta y acabe limitándola.
CREATE TABLE IF NOT EXISTS marketplace.whatsapp_suppressions (
  wa_id text PRIMARY KEY,
  reason text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON marketplace.whatsapp_conversations TO marketplace_control;
GRANT SELECT, INSERT ON marketplace.whatsapp_messages TO marketplace_control;
GRANT SELECT, INSERT ON marketplace.whatsapp_suppressions TO marketplace_control;
