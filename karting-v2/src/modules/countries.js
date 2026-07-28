// Liste des pays proposés pour la nationalité — UE au complet + principaux
// pays hors UE, "Autre" en repli final. Codes ISO 3166-1 alpha-2 conservés
// partout où possible.
//
// 🆕 v18 : extrait de register.js dans son propre module pour être partagé
// tel quel par registry.js (éditeur admin du Registre) sans entraîner les
// modules d'inscription publique (kart-avatar.js, signature-avatar.js) dans
// le bundle admin — les deux bundles n'ont besoin que de cette liste, pas du
// reste de register.js.
export const NATS = [
  { code: 'FR', flag: '🇫🇷', label: 'France' },
  { code: 'BE', flag: '🇧🇪', label: 'Belgique' },
  { code: 'DE', flag: '🇩🇪', label: 'Allemagne' },
  { code: 'IT', flag: '🇮🇹', label: 'Italie' },
  { code: 'ES', flag: '🇪🇸', label: 'Espagne' },
  { code: 'GB', flag: '🇬🇧', label: 'Angleterre' },
  { code: 'NL', flag: '🇳🇱', label: 'Pays-Bas' },
  { code: 'CH', flag: '🇨🇭', label: 'Suisse' },
  { code: 'PT', flag: '🇵🇹', label: 'Portugal' },
  { code: 'PL', flag: '🇵🇱', label: 'Pologne' },
  { code: 'AT', flag: '🇦🇹', label: 'Autriche' },
  { code: 'SE', flag: '🇸🇪', label: 'Suède' },
  { code: 'NO', flag: '🇳🇴', label: 'Norvège' },
  { code: 'DK', flag: '🇩🇰', label: 'Danemark' },
  { code: 'FI', flag: '🇫🇮', label: 'Finlande' },
  { code: 'IE', flag: '🇮🇪', label: 'Irlande' },
  { code: 'LU', flag: '🇱🇺', label: 'Luxembourg' },
  { code: 'MA', flag: '🇲🇦', label: 'Maroc' },
  { code: 'DZ', flag: '🇩🇿', label: 'Algérie' },
  { code: 'TN', flag: '🇹🇳', label: 'Tunisie' },
  { code: 'US', flag: '🇺🇸', label: 'États-Unis' },
  { code: 'CA', flag: '🇨🇦', label: 'Canada' },
  { code: 'OTHER', flag: '🌍', label: 'Autre' },
];
