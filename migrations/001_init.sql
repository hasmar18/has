-- HASNAILS – počáteční schéma databáze (PostgreSQL 13+)
-- Žádná rozšíření (extensions) nejsou potřeba. Všechny časy jsou timestamptz (UTC),
-- zobrazují se v časové zóně studia (výchozí Europe/Prague).

-- ---------------------------------------------------------------------------
-- Uživatelé, relace, jednorázové tokeny
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL,
  password_hash         text,
  role                  text NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin')),
  full_name             text,
  phone                 text,
  email_verified_at     timestamptz,
  must_change_password  boolean NOT NULL DEFAULT false,
  failed_logins         integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE sessions (
  id            text PRIMARY KEY,                 -- sha256(token) v hex; samotný token je jen v cookie
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose);

-- ---------------------------------------------------------------------------
-- Služby
-- ---------------------------------------------------------------------------
CREATE TABLE service_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id       uuid REFERENCES service_categories(id) ON DELETE SET NULL,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  duration_minutes  integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 720),
  price_czk         integer CHECK (price_czk IS NULL OR price_czk >= 0),
  price_from        boolean NOT NULL DEFAULT false,   -- zobrazit jako „od X Kč“
  is_active         boolean NOT NULL DEFAULT true,
  is_verified       boolean NOT NULL DEFAULT false,   -- údaje ověřeny podle referenčního webu
  source_note       text,
  sort_order        integer NOT NULL DEFAULT 0,
  archived_at       timestamptz,                       -- „smazané“ služby se jen archivují (historie rezervací)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Rezervace
-- ---------------------------------------------------------------------------
CREATE TABLE bookings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id               uuid REFERENCES services(id) ON DELETE SET NULL,
  user_id                  uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Snímek služby v okamžiku rezervace (změna ceny/délky/smazání služby nezmění historii)
  service_name             text NOT NULL,
  service_duration_minutes integer NOT NULL CHECK (service_duration_minutes > 0),
  price_czk                integer,

  client_name              text NOT NULL,
  client_email             text NOT NULL,
  client_phone             text NOT NULL DEFAULT '',
  client_note              text NOT NULL DEFAULT '',
  admin_note               text NOT NULL DEFAULT '',

  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL,           -- konec služby
  blocked_until            timestamptz NOT NULL,           -- konec služby + rezerva mezi klientkami
  CHECK (ends_at > starts_at),
  CHECK (blocked_until >= ends_at),

  status                   text NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled', 'completed', 'no_show', 'expired')),
  source                   text NOT NULL DEFAULT 'online' CHECK (source IN ('online', 'admin')),
  hold_expires_at          timestamptz,
  email_verified           boolean NOT NULL DEFAULT false,
  verify_code_hash         text,
  verify_attempts          integer NOT NULL DEFAULT 0,
  verify_sent_count        integer NOT NULL DEFAULT 0,

  manage_token_hash        text UNIQUE,                    -- vyhledávání podle hashe
  manage_token_enc         text,                           -- šifrovaný token (pro odkaz v připomínkách)

  conflict_override        boolean NOT NULL DEFAULT false, -- admin vědomě potvrdil kolizi
  cancelled_at             timestamptz,
  cancelled_by             text CHECK (cancelled_by IN ('client', 'admin', 'system')),
  cancel_reason            text,
  version                  integer NOT NULL DEFAULT 1,     -- zvyšuje se při každé změně času/stavu

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- Hlavní ochrana proti dvojité rezervaci: dvě aktivní rezervace se nesmí překrývat.
  -- (Admin může vytvořit rezervaci s conflict_override = true, ta je z omezení vyňata.)
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    tstzrange(starts_at, blocked_until, '[)') WITH &&
  ) WHERE (status IN ('held', 'confirmed') AND NOT conflict_override)
);
CREATE INDEX bookings_starts_idx ON bookings (starts_at);
CREATE INDEX bookings_user_idx ON bookings (user_id);
CREATE INDEX bookings_email_idx ON bookings (lower(client_email));
CREATE INDEX bookings_status_idx ON bookings (status, starts_at);
CREATE INDEX bookings_range_idx ON bookings USING gist (tstzrange(starts_at, blocked_until, '[)'))
  WHERE status IN ('held', 'confirmed');

CREATE TABLE booking_history (
  id             bigserial PRIMARY KEY,
  booking_id     uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  at             timestamptz NOT NULL DEFAULT now(),
  actor          text NOT NULL CHECK (actor IN ('client', 'admin', 'system')),
  actor_user_id  uuid,
  action         text NOT NULL,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX booking_history_booking_idx ON booking_history (booking_id, at);

CREATE TABLE reschedule_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  handled_at  timestamptz
);
CREATE INDEX reschedule_requests_status_idx ON reschedule_requests (status);

-- ---------------------------------------------------------------------------
-- Pracovní doba, blokace, výjimky
-- ---------------------------------------------------------------------------
CREATE TABLE working_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1 = pondělí
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  CHECK (end_time > start_time)
);
CREATE INDEX working_hours_weekday_idx ON working_hours (weekday);

CREATE TABLE schedule_exceptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('closed', 'open')),
  start_time  time,
  end_time    time,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from),
  CHECK (kind = 'closed' OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time AND date_from = date_to))
);

CREATE TABLE time_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text NOT NULL DEFAULT '',           -- interní, klientkám se nikdy nezobrazuje
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX time_blocks_range_idx ON time_blocks USING gist (tstzrange(starts_at, ends_at, '[)'));

-- ---------------------------------------------------------------------------
-- Nastavení a obsah webu
-- ---------------------------------------------------------------------------
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE secrets (
  key         text PRIMARY KEY,
  value_enc   text NOT NULL,                       -- AES-256-GCM
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_content (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE gallery_images (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type  text NOT NULL,
  data          bytea NOT NULL,
  width         integer,
  height        integer,
  alt           text NOT NULL DEFAULT '',
  sort_order    integer NOT NULL DEFAULT 0,
  is_hero       boolean NOT NULL DEFAULT false,
  is_visible    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Kalendáře
-- ---------------------------------------------------------------------------
CREATE TABLE calendar_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text NOT NULL,                       -- google | microsoft | (test: fake)
  account_email         text NOT NULL,
  refresh_token_enc     text NOT NULL,
  access_token_enc      text,
  access_expires_at     timestamptz,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'needs_reauth')),
  last_error            text,
  last_error_at         timestamptz,
  last_success_at       timestamptz,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  alerted_at            timestamptz,
  write_calendar_id     text,
  write_calendar_name   text,
  write_enabled         boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, account_email)
);
-- Rezervace se zapisují nejvýše do jednoho kalendáře.
CREATE UNIQUE INDEX calendar_single_write_target ON calendar_connections ((true)) WHERE write_enabled;

CREATE TABLE calendar_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id         uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  external_calendar_id  text NOT NULL,
  name                  text NOT NULL DEFAULT '',
  blocks_availability   boolean NOT NULL DEFAULT false,
  block_all_day         boolean NOT NULL DEFAULT true,
  last_synced_at        timestamptz,
  last_sync_ok          boolean,
  last_error            text,
  watch_id              text,                                  -- Google channel id / Graph subscription id
  watch_resource_id     text,
  watch_secret          text,
  watch_expires_at      timestamptz,
  UNIQUE (connection_id, external_calendar_id)
);

-- Z externích kalendářů ukládáme jen časy (nikoli názvy ani popisy událostí).
CREATE TABLE external_blocks (
  id                 bigserial PRIMARY KEY,
  source_id          uuid NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  external_event_id  text NOT NULL,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  is_all_day         boolean NOT NULL DEFAULT false,
  etag               text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_event_id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX external_blocks_range_idx ON external_blocks USING gist (tstzrange(starts_at, ends_at, '[)'));

-- Vazba rezervace ↔ událost v kalendáři (zákaznické rezervace jsou tímto označené)
CREATE TABLE booking_calendar_events (
  booking_id         uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  connection_id      uuid REFERENCES calendar_connections(id) ON DELETE SET NULL,
  calendar_id        text NOT NULL,
  external_event_id  text NOT NULL,
  etag               text,
  synced_version     integer NOT NULL DEFAULT 0,
  state              text NOT NULL DEFAULT 'synced' CHECK (state IN ('synced', 'deleted')),
  drift              text,                                     -- např. 'deleted_in_calendar', 'time_changed_in_calendar'
  last_error         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_calendar_events_ext_idx ON booking_calendar_events (external_event_id);

-- ---------------------------------------------------------------------------
-- Fronta úloh, e-maily, audit
-- ---------------------------------------------------------------------------
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key    text UNIQUE,
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 8,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  last_error    text,
  locked_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX jobs_due_idx ON jobs (status, run_at);

CREATE TABLE email_templates (
  key         text PRIMARY KEY,
  subject     text NOT NULL,
  body        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_log (
  id                   bigserial PRIMARY KEY,
  dedupe_key           text NOT NULL UNIQUE,
  template_key         text NOT NULL,
  to_email             text NOT NULL,
  subject              text NOT NULL,
  html                 text,                         -- po úspěšném odeslání se maže (minimalizace údajů)
  text_body            text,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'delivered', 'bounced')),
  provider_message_id  text,
  attempts             integer NOT NULL DEFAULT 0,
  last_error           text,
  booking_id           uuid REFERENCES bookings(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_log_status_idx ON email_log (status, created_at);
CREATE INDEX email_log_provider_idx ON email_log (provider_message_id);

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid,
  action         text NOT NULL,
  entity         text NOT NULL,
  entity_id      text,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
