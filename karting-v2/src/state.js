// État partagé de l'admin — repris à l'identique des variables globales de l'ancien
// index.html monofichier (mêmes noms, mêmes valeurs par défaut) pour ne rien casser
// côté logique métier existante. Exporté comme objet mutable unique : les modules
// lisent/écrivent `state.xxx` au lieu de variables globales éparpillées.

export const state = {
  activeSessions: [],
  activeDetailSession: null,
  inscritsData: [],
  archiveSession: null,
  selectedPilotId: null,
  helmetColors: null, // anciennement _helmetColors
  prefsDirty: false,

  // Préférences (paramètres) — valeurs par défaut identiques à l'existant.
  prefs: {
    default_karts: 12,
    default_laps: 5,
    time_unit: 'seconds',
    laps_enabled: true,
    karts_locked: true,
    kart_numbers: [],
    sectors_enabled: false,
    sector_count: 3,
    results_theme: 'classic',
    helmet_choice: 1,
    helmet_colors: null,
  },
};

export function markPrefsDirty() {
  state.prefsDirty = true;
}

export function setPrefs(newPrefs) {
  state.prefs = { ...state.prefs, ...newPrefs };
}
