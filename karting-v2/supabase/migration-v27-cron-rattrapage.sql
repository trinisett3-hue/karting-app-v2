-- =====================================================================
-- Migration v27 — Cron de rattrapage de l'envoi des resultats
-- =====================================================================
-- Toutes les 5 minutes, et non toutes les minutes : le but n'est pas
-- d'envoyer (la publication le fait deja immediatement) mais de reprendre
-- ce qui a echoue. Une ligne de card_deliveries passe de 'pending' a 'sent'
-- une seule fois, donc un pilote ne recoit jamais deux e-mails, quelle que
-- soit la frequence du cron.
--
-- Pas d'en-tete Authorization : la fonction est deployee avec
-- verify_jwt = false (pg_cron n'a pas de JWT a presenter) et ne fait rien
-- d'autre que vider une file deja constituee.

select cron.unschedule('rattrapage-envoi-resultats')
 where exists (select 1 from cron.job where jobname = 'rattrapage-envoi-resultats');

select cron.schedule(
  'rattrapage-envoi-resultats',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url     := 'https://yfgrvfdjakjnmryhtpgo.supabase.co/functions/v1/send-result-emails',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body    := '{"source":"cron"}'::jsonb,
      timeout_milliseconds := 55000
    );
  $cron$
);
