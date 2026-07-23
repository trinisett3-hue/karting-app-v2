// Configuration centrale de l'application Karting v2.
// Pointe vers le nouveau projet Supabase dédié à la v2 (karting-app-v2).
// Le schéma reproduit à l'identique celui de l'app d'origine (voir
// supabase/migration-v2.sql) : mêmes fonctionnalités, nouvelle base vide.
export const APP_CONFIG = {
  supabaseUrl: 'https://yfgrvfdjakjnmryhtpgo.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlmZ3J2ZmRqYWtqbm1yeWh0cGdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3MzQ2NDYsImV4cCI6MjEwMDMxMDY0Nn0.swQCn6gp_FZl-jxlB-Pn0olbKWuZMUDC5CR1ksw72J4',
  baseUrl: window.location.origin,
};
