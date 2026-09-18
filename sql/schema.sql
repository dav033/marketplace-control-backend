BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS marketplace;

CREATE TABLE IF NOT EXISTS marketplace.providers (
  provider_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text UNIQUE,
  legal_name text,
  display_name text NOT NULL,
  category text NOT NULL,
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
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','under_review','approved','rejected','archived')),
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
  ses_configuration_set text,
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
  ses_message_id text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_event_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
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
  email text NOT NULL CHECK (email = lower(email)),
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

-- Compatibilidad con instalaciones MVP creadas antes de este esquema completo.
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS latitude numeric(9,6);
ALTER TABLE marketplace.providers ADD COLUMN IF NOT EXISTS longitude numeric(9,6);
ALTER TABLE marketplace.registration_submissions ADD COLUMN IF NOT EXISTS consent_ip inet;
ALTER TABLE marketplace.campaigns ADD COLUMN IF NOT EXISTS body_text text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_email ON marketplace.contacts (lower(email));
CREATE INDEX IF NOT EXISTS ix_providers_status_city_category ON marketplace.providers (status, city, category);
CREATE INDEX IF NOT EXISTS ix_provider_sources_provider ON marketplace.provider_sources (provider_id);
CREATE INDEX IF NOT EXISTS ix_contacts_consent ON marketplace.contacts (consent_status, suppressed_at);
CREATE INDEX IF NOT EXISTS ix_campaigns_status_schedule ON marketplace.campaigns (status, scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_sends_ses_message ON marketplace.campaign_sends (ses_message_id) WHERE ses_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_campaign_sends_campaign_status ON marketplace.campaign_sends (campaign_id, status);
CREATE INDEX IF NOT EXISTS ix_email_clicks_send_time ON marketplace.email_clicks (send_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS ix_registration_status_time ON marketplace.registration_submissions (submission_status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_registration_email ON marketplace.registration_submissions (lower(email));

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

COMMIT;
