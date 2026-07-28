-- ============================================================
-- MIGRATION ADDITIVE — v13 (2026-07-28)
-- ============================================================
-- Ce fichier ne modifie AUCUNE colonne existante et ne casse aucune ligne
-- déjà en base : uniquement des `ADD COLUMN IF NOT EXISTS` (sans NOT NULL)
-- et, en toute fin de fichier, les DROP POLICY déjà annoncés dans
-- migration-v2.sql / README.md (roadmap "Supprimer les policies RLS
-- temporaires") maintenant que l'authentification admin est branchée
-- (voir src/modules/auth.js + app.js > doLogin/doLogout).
--
-- À appliquer manuellement sur le projet Supabase (yfgrvfdjakjnmryhtpgo),
-- comme migration-v2.sql — ce fichier n'est pas rejoué automatiquement.
-- ============================================================

-- --------------------------------------------------------------
-- 1) session_registrations.email — inscription (register.html)
-- --------------------------------------------------------------
-- Volontairement NULLABLE en base : le formulaire le rend obligatoire
-- CÔTÉ FRONT (register.js > submitForm), mais aucune contrainte NOT NULL
-- n'est posée ici. Les inscriptions déjà en base (créées avant ce champ)
-- ont donc email = NULL et restent valides ; aucun code lu dans le projet
-- (sessions.js, results.js, public-results.js) ne suppose email non-null
-- (aucune de ces requêtes ne sélectionne/filtre sur cette colonne).
ALTER TABLE session_registrations ADD COLUMN IF NOT EXISTS email TEXT;

-- --------------------------------------------------------------
-- 1bis) session_registrations.first_name / last_name — demande client
--       post-v13 (identité/contact réelle du pilote, distincte du PSEUDO).
-- --------------------------------------------------------------
-- Le PSEUDO reste porté par display_name (colonne existante, déjà utilisée
-- partout côté affichage public — podium, classement, PDF). first_name/
-- last_name ne sont QUE des champs de contact/identité liés à l'email :
-- rien côté affichage public ne les lit. Nullable, comme email : le
-- formulaire les rend obligatoires côté front, jamais en base.
ALTER TABLE session_registrations ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE session_registrations ADD COLUMN IF NOT EXISTS last_name TEXT;

-- --------------------------------------------------------------
-- 2) sessions.session_type — Point 10 (tags de session)
-- --------------------------------------------------------------
-- Valeurs attendues côté front : 'loisir' | 'competition' | 'initiation'
-- | 'entrainement'. Pas de CHECK contraignant pour rester tolérant aux
-- anciennes lignes (NULL = pas de tag, traité comme "Loisir" par défaut
-- côté affichage uniquement, jamais en base).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_type TEXT;

-- --------------------------------------------------------------
-- 3) sessions.internal_notes — Point 11 (notes internes)
-- --------------------------------------------------------------
-- Jamais exposé côté page publique (results.html / public-results.js ne
-- sélectionnent pas cette colonne).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS internal_notes TEXT;

-- ============================================================
-- 4) Durcissement RLS — auth admin déjà branchée (24/07/2026)
-- ============================================================
-- Ces policies temporaires (voir migration-v2.sql, section "État actuel
-- des policies RLS") n'ont plus lieu d'être maintenant que app.js exige
-- une session Supabase Auth valide avant d'initialiser sessions/results/
-- settings (voir login-overlay dans admin.html + doLogin()/doLogout()
-- dans app.js). Les tenir ouvertes laisserait n'importe qui avec la clé
-- anon lire/écrire les données de n'importe quel tenant, malgré le login.
--
-- ⚠️ À exécuter seulement après avoir vérifié que chaque admin existant a
-- bien un compte Supabase Auth + une ligne tenant_users correspondante
-- (sans quoi il perdrait l'accès en même temps que ces policies tombent) :
DROP POLICY IF EXISTS "temp_test_all_session_registrations" ON session_registrations;
DROP POLICY IF EXISTS "temp_test_all_laps" ON laps;
DROP POLICY IF EXISTS "admin_all_sessions" ON sessions;
