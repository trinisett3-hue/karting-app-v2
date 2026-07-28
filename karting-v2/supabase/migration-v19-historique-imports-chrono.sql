-- ============================================================
-- MIGRATION ADDITIVE — v19 (2026-07-28)
-- Historique des imports de chronos (texte brut colle ou genere depuis un
-- fichier Excel/CSV) : jusqu'ici ce texte etait traite puis jete, sans
-- aucune trace. Le client a signale qu'apres coup, quand un import laisse
-- des trous (temps manquants, kart oublie...), il n'y a aucun moyen de
-- retrouver ce qui avait ete colle/importe pour comprendre ce qui a ete
-- rate. chrono_imports garde donc un historique complet, telechargeable
-- depuis les archives d'une session (voir results.js > openArchiveDetail).
--
-- À appliquer manuellement sur le projet Supabase (yfgrvfdjakjnmryhtpgo),
-- comme les migrations precedentes — deja applique en production le
-- 2026-07-28.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.chrono_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id),
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  raw_text TEXT NOT NULL,
  lines_count INT,
  imported_count INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chrono_imports_session_idx ON public.chrono_imports (session_id, created_at DESC);

ALTER TABLE public.chrono_imports ENABLE ROW LEVEL SECURITY;

-- Meme trigger/pattern que sessions/laps/session_registrations (voir
-- migration-v2.sql) : tenant_id auto-rempli via private.current_tenant_id()
-- a l'insertion, jamais envoye explicitement par le front.
DROP TRIGGER IF EXISTS trg_autofill_tenant_chrono_imports ON public.chrono_imports;
CREATE TRIGGER trg_autofill_tenant_chrono_imports
  BEFORE INSERT ON public.chrono_imports
  FOR EACH ROW EXECUTE FUNCTION public.autofill_tenant_id();

-- Reservee a l'admin authentifie de ce tenant (comme laps_auth/sessions_auth) :
-- pas de lecture publique, ce texte peut contenir des noms/pseudos non
-- encore valides ni nettoyes.
DROP POLICY IF EXISTS chrono_imports_auth ON public.chrono_imports;
CREATE POLICY chrono_imports_auth ON public.chrono_imports
  FOR ALL
  USING (tenant_id IS NOT NULL AND tenant_id = private.current_tenant_id())
  WITH CHECK (tenant_id IS NOT NULL AND tenant_id = private.current_tenant_id());
