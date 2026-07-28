// Point d'entrée de la page publique d'inscription (register.html).
// Câble le module register.js sur le HTML : initialise la page au chargement
// et expose les fonctions utilisées en onclick="..." sur window (comme app.js
// le fait pour l'admin).
import * as register from './modules/register.js';

window.addEventListener('DOMContentLoaded', async () => {
  register.renderNats();
  await register.initRegisterPage();
});

Object.assign(window, {
  selectNat: register.selectNat,
  natComboOpen: register.natComboOpen,
  natComboFilter: register.natComboFilter,
  natComboSelect: register.natComboSelect,
  submitForm: register.submitForm,
  goFirstTime: register.goFirstTime,
  goAlreadyPilot: register.goAlreadyPilot,
  backToScreen0: register.backToScreen0,
  createPilot: register.createPilot,
  searchPilot: register.searchPilot,
  confirmPilotFound: register.confirmPilotFound,
  avatarPrev: register.avatarPrev,
  avatarNext: register.avatarNext,
});
