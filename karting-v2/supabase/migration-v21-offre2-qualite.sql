-- ============================================================
-- MIGRATION ADDITIVE — v21 (Offre 2, bloc "Experience & qualite")
-- Ajoute le strict minimum de schema necessaire aux nouveaux KPIs Offre 2 :
--  - sessions.incident_count / sessions.interruption_minutes : saisis
--    manuellement a la cloture d'une session (voir admin.html > Archives >
--    "Notes internes / type de session", et results.js > saveArchiveMeta()).
--    Pas de capteur automatique pour l'instant — 0 par defaut, donc le KPI
--    "Taux d'incident" affichera honnêtement 0% tant que rien n'est saisi,
--    plutot que d'inventer une donnee.
--  - session_ratings : note de satisfaction (CSAT) 1-5, une ligne par
--    reponse. Le WIDGET de notation cote page publique (results.html) N'EST
--    PAS construit dans cette tache — seul le schema + l'agregation admin
--    existent, comme demande ("suppose l'existence ou l'ajout d'un rating
--    simple ... a brancher plus tard si necessaire"). Tant qu'aucune ligne
--    n'existe, le CSAT s'affiche "--" (aucune donnee), jamais une valeur
--    inventee.
--
-- À appliquer manuellement sur le projet Supabase (yfgrvfdjakjnmryhtpgo),
-- comme les migrations precedentes.
-- ============================================================

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS incident_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interruption_minutes INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.session_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_ratings_session_idx ON public.session_ratings (session_id, created_at DESC);

ALTER TABLE public.session_ratings ENABLE ROW LEVEL SECURITY;

-- Meme trigger/pattern que chrono_imports (migration-v19) : tenant_id
-- auto-rempli via private.current_tenant_id() a l'insertion.
DROP TRIGGER IF EXISTS trg_autofill_tenant_session_ratings ON public.session_ratings;
CREATE TRIGGER trg_autofill_tenant_session_ratings
  BEFORE INSERT ON public.session_ratings
  FOR EACH ROW EXECUTE FUNCTION public.autofill_tenant_id();

-- Lecture/ecriture reservees a l'admin authentifie de ce tenant, comme les
-- autres tables "_auth". Une eventuelle notation publique cote resultats
-- (pilote note sa session) necessitera plus tard une RPC SECURITY DEFINER
-- dediee (meme logique que public_site_config()) — PAS un accès direct
-- anon/authenticated a cette table, pour eviter qu'un lien de resultats
-- publie serve a manipuler les notes d'un autre tenant.
DROP POLICY IF EXISTS session_ratings_auth ON public.session_ratings;
CREATE POLICY session_ratings_auth ON public.session_ratings
  FOR ALL
  USING (tenant_id IS NOT NULL AND tenant_id = private.current_tenant_id())
  WITH CHECK (tenant_id IS NOT NULL AND tenant_id = private.current_tenant_id());
