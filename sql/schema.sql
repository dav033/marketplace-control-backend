BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS marketplace;

CREATE TABLE IF NOT EXISTS marketplace.providers (
  provider_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text UNIQUE,
  legal_name text,
  display_name text NOT NULL,
  category text NOT NULL,
  -- Categorías adicionales reales según los servicios que el negocio ofrece (ej. un hotel que
  -- también hace catering y eventos de entretenimiento). `category` sigue siendo la principal:
  -- define el ID, el dedupe_key y el umbral de reputación exigido.
  additional_categories text[] NOT NULL DEFAULT '{}',
  city text NOT NULL,
  country_code char(2) NOT NULL DEFAULT 'CO',
  website_url text,
  phone text,
  address text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  rating numeric(2,1),
  review_count integer,
  contact_channel text NOT NULL DEFAULT 'whatsapp' CHECK (contact_channel IN ('email','whatsapp')),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','unconfirmed','under_review','approved','rejected','archived')),
  discovery_source text,
  notes text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  CHECK (review_count IS NULL OR review_count >= 0),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);

ALTER TABLE marketplace.providers
  ADD COLUMN IF NOT EXISTS contact_channel text NOT NULL DEFAULT 'whatsapp';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'providers_contact_channel_check'
      AND conrelid = 'marketplace.providers'::regclass
  ) THEN
    ALTER TABLE marketplace.providers
      ADD CONSTRAINT providers_contact_channel_check CHECK (contact_channel IN ('email','whatsapp'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketplace.provider_sources (
  provider_source_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES marketplace.providers(provider_id) ON DELETE CASCADE,
  source_name text NOT NULL,
  source_url text,
  source_record_key text,
  source_fingerprint text NOT NULL UNIQUE,
  observed_name text,
  observed_rating numeric(2,1),
  observed_reviews integer,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (observed_rating IS NULL OR observed_rating BETWEEN 0 AND 5),
  CHECK (observed_reviews IS NULL OR observed_reviews >= 0)
);

CREATE TABLE IF NOT EXISTS marketplace.contacts (
  contact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES marketplace.providers(provider_id) ON DELETE SET NULL,
  full_name text,
  email text NOT NULL CHECK (email = lower(email)),
  phone text,
  consent_status text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown','granted','revoked')),
  consent_at timestamptz,
  consent_source text,
  consent_text_version text,
  consent_ip_hash bytea,
  consent_user_agent_hash bytea,
  suppressed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(email) BETWEEN 3 AND 320),
  CHECK (consent_status <> 'granted' OR consent_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS marketplace.campaigns (
  campaign_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  campaign_type text NOT NULL DEFAULT 'marketing' CHECK (campaign_type IN ('marketing','transactional')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','paused','completed','cancelled')),
  subject text NOT NULL,
  body_text text NOT NULL DEFAULT '',
  sender_email text NOT NULL CHECK (sender_email = lower(sender_email)),
  reply_to_email text CHECK (reply_to_email IS NULL OR reply_to_email = lower(reply_to_email)),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace.campaign_sends (
  send_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES marketplace.campaigns(campaign_id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES marketplace.contacts(contact_id),
  provider_id uuid REFERENCES marketplace.providers(provider_id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','delivered','bounced','complaint','failed','suppressed','opted_out')),
  tracking_token_hash text NOT NULL UNIQUE CHECK (tracking_token_hash ~ '^[0-9a-f]{64}$'),
  provider_message_id text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_event_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);

CREATE TABLE IF NOT EXISTS marketplace.campaign_personalizations (
  personalization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES marketplace.campaigns(campaign_id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES marketplace.contacts(contact_id) ON DELETE CASCADE,
  provider_id uuid REFERENCES marketplace.providers(provider_id) ON DELETE SET NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  ai_model text NOT NULL,
  ai_confidence numeric(4,3),
  facts_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','synced','sent','failed','rejected')),
  omnisend_contact_id text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id),
  CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1)
);

CREATE TABLE IF NOT EXISTS marketplace.email_clicks (
  click_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id uuid NOT NULL REFERENCES marketplace.campaign_sends(send_id) ON DELETE CASCADE,
  link_key text NOT NULL,
  clicked_at timestamptz NOT NULL DEFAULT now(),
  ip_hash bytea,
  user_agent_hash bytea,
  was_prefetch boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS marketplace.registration_submissions (
  submission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES marketplace.providers(provider_id) ON DELETE SET NULL,
  full_name text,
  -- Opcional: una ficha que nace de una conversación de WhatsApp puede no traer correo; el número ya es
  -- el canal de contacto y una persona del equipo completa el resto.
  email text CHECK (email = lower(email)),
  phone text,
  company_name text,
  submission_status text NOT NULL DEFAULT 'new' CHECK (submission_status IN ('new','reviewing','approved','rejected','spam','converted')),
  privacy_consent boolean NOT NULL DEFAULT false,
  privacy_consent_at timestamptz,
  marketing_consent boolean NOT NULL DEFAULT false,
  marketing_consent_at timestamptz,
  consent_source text,
  consent_text_version text,
  consent_ip inet,
  consent_user_agent_hash bytea,
  form_version text,
  idempotency_key text UNIQUE,
  form_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(email) BETWEEN 3 AND 320),
  CHECK (privacy_consent = true AND privacy_consent_at IS NOT NULL),
  CHECK (marketing_consent = false OR marketing_consent_at IS NOT NULL)
);

-- Fase 2: el enlace del correo caduca y el formulario se envia una sola vez.
-- `token_expires_at` nulo significa un envio anterior a esta migracion: se trata como vigente para
-- no invalidar enlaces ya repartidos.
ALTER TABLE marketplace.campaign_sends
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS form_submitted_at timestamptz;

-- Lo que el proveedor declara sobre si mismo. Productos en lista abierta; servicios acotados a las
-- 11 categorias oficiales; volumen como rango de asistentes, del que se deriva la Escala de
-- curaduria sin pedirle al proveedor que entienda esa clasificacion interna.
ALTER TABLE marketplace.registration_submissions
  ADD COLUMN IF NOT EXISTS products text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS services text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS volume_min integer,
  ADD COLUMN IF NOT EXISTS volume_max integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'registration_submissions_products_check'
      AND conrelid = 'marketplace.registration_submissions'::regclass
  ) THEN
    ALTER TABLE marketplace.registration_submissions
      ADD CONSTRAINT registration_submissions_products_check
      CHECK (cardinality(products) <= 10);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'registration_submissions_services_check'
      AND conrelid = 'marketplace.registration_submissions'::regclass
  ) THEN
    ALTER TABLE marketplace.registration_submissions
      ADD CONSTRAINT registration_submissions_services_check
      CHECK (cardinality(services) <= 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'registration_submissions_volume_check'
      AND conrelid = 'marketplace.registration_submissions'::regclass
  ) THEN
    ALTER TABLE marketplace.registration_submissions
      ADD CONSTRAINT registration_submissions_volume_check
      CHECK (
        (volume_min IS NULL AND volume_max IS NULL)
        OR (volume_min >= 1 AND volume_max >= volume_min AND volume_max <= 100000)
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketplace.audit_log (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_ip inet,
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace.curation_scans (
  scan_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city text NOT NULL,
  category text NOT NULL,
  instructions text,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','failed')),
  research_summary text,
  discovered_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  contactable_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace.curation_candidates (
  scan_candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES marketplace.curation_scans(scan_id) ON DELETE CASCADE,
  candidate_key text NOT NULL,
  display_name text NOT NULL,
  category text NOT NULL,
  city text NOT NULL,
  source_url text,
  status text NOT NULL CHECK (status IN ('accepted','rejected')),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_tsv text NOT NULL DEFAULT '',
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, candidate_key)
);

-- Compatibilidad con instalaciones MVP creadas antes de este esquema completo.
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS latitude numeric(9,6);
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS longitude numeric(9,6);
ALTER TABLE marketplace.registration_submissions ADD COLUMN IF NOT EXISTS consent_ip inet;
ALTER TABLE marketplace.campaigns ADD COLUMN IF NOT EXISTS body_text text NOT NULL DEFAULT '';
ALTER TABLE marketplace.registration_submissions ALTER COLUMN email DROP NOT NULL;

-- Contacto por WhatsApp: en qué punto está cada proveedor (ver src/lib/conversation-status.ts).
-- NULL = nunca se le escribió. `whatsapp_sent_at` es cuándo salió la invitación: cuenta para el cupo
-- diario de Meta y no cambia aunque luego cambie el estado.
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS whatsapp_status text;
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS whatsapp_status_at timestamptz;
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS whatsapp_status_reason text;
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS whatsapp_sent_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'providers_whatsapp_status_check' AND conrelid = 'marketplace.providers'::regclass
  ) THEN
    ALTER TABLE marketplace.providers
      ADD CONSTRAINT providers_whatsapp_status_check
      CHECK (whatsapp_status IS NULL OR whatsapp_status IN (
        'mensaje_enviado', 'conversacion_iniciada', 'conversacion_aceptada',
        'conversacion_rechazada', 'rechazado', 'inscrito'
      ));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_providers_whatsapp_status ON marketplace.providers (whatsapp_status);
CREATE INDEX IF NOT EXISTS ix_providers_whatsapp_sent ON marketplace.providers (whatsapp_sent_at) WHERE whatsapp_sent_at IS NOT NULL;

-- De qué proveedor era cada mensaje. En modo prueba todas las invitaciones llegan al mismo teléfono
-- y comparten conversación, así que el número ya no basta para reconstruir el hilo de cada ficha.
ALTER TABLE marketplace.whatsapp_messages ADD COLUMN IF NOT EXISTS provider_id uuid REFERENCES marketplace.providers(provider_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_whatsapp_messages_provider ON marketplace.whatsapp_messages (provider_id, occurred_at);

-- Ciudades del marketplace. Una ciudad "cerrada" es una en la que todavía no operamos; al abrirla se
-- anuncia a sus proveedores que ya pueden registrarse (ver src/lib/cities.ts). El anuncio no sale por
-- abrir la ciudad: sale cuando alguien lo confirma desde el panel.
CREATE TABLE IF NOT EXISTS marketplace.cities (
  city_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  country_code char(2) NOT NULL DEFAULT 'CO',
  status text NOT NULL DEFAULT 'cerrada' CHECK (status IN ('cerrada', 'abierta')),
  opened_at timestamptz,
  announced_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- El nombre es la clave real: la curaduría y los proveedores hablan de "Barranquilla", no de un uuid.
CREATE UNIQUE INDEX IF NOT EXISTS ux_cities_name ON marketplace.cities (lower(name), country_code);

-- Un anuncio por ciudad y proveedor: si el envío se repite o se reintenta, nadie recibe dos veces el
-- mismo aviso. Guarda también los fallos, que es lo que el panel enseña al terminar.
CREATE TABLE IF NOT EXISTS marketplace.city_announcements (
  announcement_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES marketplace.cities(city_id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES marketplace.providers(provider_id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, provider_id)
);
CREATE INDEX IF NOT EXISTS ix_city_announcements_city ON marketplace.city_announcements (city_id, status);

-- Las ciudades que ya tienen proveedores existen de hecho: se crean cerradas para no anunciar nada
-- por sorpresa. Idempotente, así que el deploy puede repetirlo.
INSERT INTO marketplace.cities (name)
SELECT DISTINCT trim(p.city) FROM marketplace.providers p
WHERE trim(p.city) <> ''
ON CONFLICT DO NOTHING;

-- Las ciudades importantes del país entran cerradas: estar en la lista no anuncia nada, solo permite
-- abrirlas cuando el marketplace llegue a cada una. Idempotente: el deploy puede repetirlo.
INSERT INTO marketplace.cities (name) VALUES
  ('Bogotá'),
  ('Medellín'),
  ('Cali'),
  ('Barranquilla'),
  ('Cartagena'),
  ('Cúcuta'),
  ('Bucaramanga'),
  ('Pereira'),
  ('Santa Marta'),
  ('Ibagué'),
  ('Manizales'),
  ('Villavicencio'),
  ('Pasto'),
  ('Neiva'),
  ('Armenia'),
  ('Montería'),
  ('Valledupar'),
  ('Sincelejo'),
  ('Popayán'),
  ('Tunja'),
  ('Riohacha'),
  ('Yopal'),
  ('Florencia'),
  ('Quibdó'),
  ('Arauca'),
  ('San Andrés'),
  ('Leticia'),
  ('Mocoa'),
  ('San José del Guaviare'),
  ('Soledad'),
  ('Malambo'),
  ('Puerto Colombia'),
  ('Bello'),
  ('Envigado'),
  ('Itagüí'),
  ('Rionegro'),
  ('Palmira'),
  ('Jamundí'),
  ('Buenaventura'),
  ('Tuluá'),
  ('Cartago'),
  ('Floridablanca'),
  ('Piedecuesta'),
  ('Girón'),
  ('Barrancabermeja'),
  ('Sogamoso'),
  ('Duitama'),
  ('Chía'),
  ('Zipaquirá'),
  ('Girardot'),
  ('Fusagasugá'),
  ('Facatativá'),
  ('Mosquera'),
  ('Funza'),
  ('Madrid'),
  ('Apartadó'),
  ('Magangué'),
  ('Ciénaga'),
  ('Maicao'),
  ('Ocaña'),
  ('Tumaco'),
  ('Ipiales'),
  ('Espinal'),
  ('Pitalito')
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_email ON marketplace.contacts (lower(email));
CREATE INDEX IF NOT EXISTS ix_providers_status_city_category ON marketplace.providers (status, city, category);
CREATE INDEX IF NOT EXISTS ix_provider_sources_provider ON marketplace.provider_sources (provider_id);
CREATE INDEX IF NOT EXISTS ix_contacts_consent ON marketplace.contacts (consent_status, suppressed_at);
CREATE INDEX IF NOT EXISTS ix_campaigns_status_schedule ON marketplace.campaigns (status, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_sends_provider_message ON marketplace.campaign_sends (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_campaign_sends_campaign_status ON marketplace.campaign_sends (campaign_id, status);
CREATE INDEX IF NOT EXISTS ix_campaign_personalizations_status ON marketplace.campaign_personalizations (campaign_id, status);
CREATE INDEX IF NOT EXISTS ix_email_clicks_send_time ON marketplace.email_clicks (send_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS ix_registration_status_time ON marketplace.registration_submissions (submission_status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_registration_email ON marketplace.registration_submissions (lower(email));
CREATE INDEX IF NOT EXISTS ix_curation_scans_city_category ON marketplace.curation_scans (lower(city), lower(category), created_at DESC);
CREATE INDEX IF NOT EXISTS ix_curation_candidates_blacklist ON marketplace.curation_candidates (lower(city), lower(category), candidate_key);

CREATE OR REPLACE FUNCTION marketplace.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_providers_updated_at' AND tgrelid = 'marketplace.providers'::regclass) THEN
    CREATE TRIGGER trg_providers_updated_at BEFORE UPDATE ON marketplace.providers FOR EACH ROW EXECUTE FUNCTION marketplace.touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contacts_updated_at' AND tgrelid = 'marketplace.contacts'::regclass) THEN
    CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON marketplace.contacts FOR EACH ROW EXECUTE FUNCTION marketplace.touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_campaigns_updated_at' AND tgrelid = 'marketplace.campaigns'::regclass) THEN
    CREATE TRIGGER trg_campaigns_updated_at BEFORE UPDATE ON marketplace.campaigns FOR EACH ROW EXECUTE FUNCTION marketplace.touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_campaign_sends_updated_at' AND tgrelid = 'marketplace.campaign_sends'::regclass) THEN
    CREATE TRIGGER trg_campaign_sends_updated_at BEFORE UPDATE ON marketplace.campaign_sends FOR EACH ROW EXECUTE FUNCTION marketplace.touch_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_registration_updated_at' AND tgrelid = 'marketplace.registration_submissions'::regclass) THEN
    CREATE TRIGGER trg_registration_updated_at BEFORE UPDATE ON marketplace.registration_submissions FOR EACH ROW EXECUTE FUNCTION marketplace.touch_updated_at();
  END IF;
END;
$$;

-- El agente de WhatsApp actualiza la ficha que ya guardó cuando el proveedor cambia algo después, y
-- deja el antes y el después en audit_log. Solo si el rol de la aplicación existe en esta instalación.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'marketplace_control') THEN
    GRANT SELECT, INSERT, UPDATE ON marketplace.registration_submissions TO marketplace_control;
    GRANT SELECT, INSERT, UPDATE ON marketplace.cities TO marketplace_control;
    -- UPDATE porque el registro del anuncio es un upsert (un reintento pisa el fallo anterior);
    -- sin él la fila no se escribía y el mismo proveedor podía recibir el anuncio dos veces.
    GRANT SELECT, INSERT, UPDATE ON marketplace.city_announcements TO marketplace_control;
    GRANT SELECT, INSERT ON marketplace.audit_log TO marketplace_control;
  END IF;
END;
$$;

COMMIT;
