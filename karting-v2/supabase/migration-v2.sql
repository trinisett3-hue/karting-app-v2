-- ============================================================
-- SCHÉMA SUPABASE — karting-app-v2 (multi-tenant)
-- ============================================================
-- Ce fichier documente le schéma RÉELLEMENT en place sur le projet
-- yfgrvfdjakjnmryhtpgo (déjà appliqué directement via l'assistant Supabase —
-- pas besoin de le rejouer). Il sert de référence si tu dois reconstruire
-- ce schéma sur un autre projet Supabase (ex: futur environnement de prod
-- séparé du test).
--
-- Architecture : multi-tenant dès le départ (tenants / organizations /
-- venues), pensée pour accueillir plusieurs clubs/organisateurs à terme.
-- Chaque ligne de sessions / session_registrations / laps / drivers /
-- app_settings porte un tenant_id, rempli automatiquement à l'insertion
-- par un trigger (autofill_tenant_id) qui lit current_tenant_id() —
-- lui-même résolu via la session Supabase Auth de l'utilisateur connecté
-- (table tenant_users). Tout ça suppose une authentification admin, qui
-- n'est PAS encore branchée dans le code (voir README, section Roadmap).
-- ============================================================

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  tenant_id UUID REFERENCES tenants(id),
  role TEXT DEFAULT 'staff'
);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS venues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  name TEXT NOT NULL,
  city TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  venue_id UUID REFERENCES venues(id),
  title TEXT NOT NULL,
  max_karts INT NOT NULL CHECK (max_karts > 0),
  status TEXT NOT NULL DEFAULT 'registration_open'
    CHECK (status IN ('registration_open','registration_closed','kart_assignment','chrono_imported','results_published')),
  public_registration_token TEXT UNIQUE DEFAULT encode(extensions.gen_random_bytes(12), 'hex'),
  public_results_token TEXT UNIQUE DEFAULT encode(extensions.gen_random_bytes(12), 'hex'),
  starts_at TIMESTAMPTZ,
  session_date DATE DEFAULT CURRENT_DATE,
  archived_at TIMESTAMPTZ,
  notes TEXT,
  laps_count INT DEFAULT 5,
  circuit_name TEXT -- affiché sur la page publique de résultats ; vide = "Circuit de Trinisette" par défaut côté front
);

CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  nationality TEXT DEFAULT 'OTHER',
  photo_url TEXT,
  avatar_index INT, -- 0-9, casque SVG généré si pas de photo_url
  avatar_hue INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  session_id UUID NOT NULL REFERENCES sessions(id),
  driver_id UUID REFERENCES drivers(id),
  display_name TEXT NOT NULL,
  nationality TEXT DEFAULT 'OTHER',
  kart_number INT,
  is_unknown BOOLEAN NOT NULL DEFAULT false,
  avatar_color_scheme INT, -- 0-9, palette du casque SVG affiché dans les résultats
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS laps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  session_id UUID NOT NULL REFERENCES sessions(id),
  registration_id UUID NOT NULL REFERENCES session_registrations(id),
  lap_index INT NOT NULL CHECK (lap_index > 0),
  lap_time_seconds NUMERIC NOT NULL CHECK (lap_time_seconds > 0),
  sector_1_seconds DOUBLE PRECISION,
  sector_2_seconds DOUBLE PRECISION,
  sector_3_seconds DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB,
  tenant_id UUID REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS results_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID UNIQUE NOT NULL REFERENCES sessions(id),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Fonction utilisée par toutes les policies RLS "*_auth" ci-dessous : résout le tenant
-- de l'utilisateur Supabase Auth actuellement connecté.
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid() LIMIT 1;
$$;

-- Trigger d'auto-remplissage de tenant_id à l'insertion (évite d'avoir à modifier le
-- code applicatif existant, qui n'envoie jamais tenant_id explicitement).
CREATE OR REPLACE FUNCTION autofill_tenant_id()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := current_tenant_id();
  END IF;
  RETURN NEW;
END;
$$;
-- À rejouer sur : sessions, session_registrations, laps, drivers, app_settings
-- CREATE TRIGGER trg_autofill_tenant_<table> BEFORE INSERT ON <table>
--   FOR EACH ROW EXECUTE FUNCTION autofill_tenant_id();

-- ============================================================
-- ⚠️ ÉTAT ACTUEL DES POLICIES RLS (à durcir avant la vraie mise en prod)
-- ============================================================
-- Public (register.html / results.html), sans authentification :
--   sessions               : lecture par token (inscription et résultats)
--   session_registrations  : lecture publique + insertion publique (inscription)
--   laps                   : lecture publique (résultats)
--
-- Admin, PENDANT LA PHASE DE TEST (auth pas encore branchée dans le code) :
--   sessions, session_registrations, laps : policies "temp_test_all_*" / "admin_all_*"
--   grandes ouvertes (using true / with check true) pour permettre de tester
--   sans login. À SUPPRIMER une fois l'authentification admin branchée
--   (src/modules/auth.js existe déjà mais n'est pas encore câblé dans app.js) :
--     DROP POLICY "temp_test_all_session_registrations" ON session_registrations;
--     DROP POLICY "temp_test_all_laps" ON laps;
--     DROP POLICY "admin_all_sessions" ON sessions;
--   Les policies "*_auth" (tenant_id = current_tenant_id()) resteront alors les
--   seules à s'appliquer côté admin, exactement comme prévu pour un vrai
--   environnement multi-client.
