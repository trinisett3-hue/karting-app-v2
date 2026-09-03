// ---------------------------------------------------------------------------
// venue-poster.js — Affiche A4 « QR permanent du circuit », prete a imprimer.
//
// MODELE UNIQUE : identique pour tous les circuits. Aucun theme, aucun logo,
// aucun nom de circuit — seul le lien encode dans le QR change d'un client a
// l'autre. Consequence voulue : aucune dependance a app_settings, aucune image
// distante a charger (donc aucun risque CORS), et une mise en page qui ne peut
// pas casser a cause d'un nom trop long ou d'un logo bancal.
//
// PDF VECTORIEL (pas de html2canvas) : le texte reste net a l'impression. Seul
// le QR est une image, posee en 1100 px pour 100 mm (~280 dpi).
//
// Dependances : jsPDF (deja charge dans admin.html) et qrCanvas() de qr.js.
// ---------------------------------------------------------------------------
import { qrCanvas } from './qr.js';

const PAGE = { w: 210, h: 297 };
const M = 14;                       // marge de securite : aucune imprimante de bureau n'imprime bord a bord
const INNER = PAGE.w - M * 2;
const CX = PAGE.w / 2;

const ACC = [232, 68, 43];          // rouge TRINISETTE (identique a la vitrine) — jamais le theme du circuit
const GREY_LINE = [226, 228, 234];
const GREY_TEXT = [107, 112, 128];
const FAINT = [154, 160, 174];
const DARK = [16, 17, 20];
const BODY = [58, 61, 71];

function charSpace(pdf, v) { try { pdf.setCharSpace(v); } catch (e) {} }

/**
 * Construit le document. Expose separement de la sauvegarde pour pouvoir
 * verifier le rendu (tests, apercu) sans declencher de telechargement.
 * @param {string} url        lien du QR : <origin>/register?v=<public_venue_token>
 * @param {object} [opts]     { showBadge:boolean } — pied « Propulse par TRINISETTE », vrai par defaut
 */
export function buildVenuePosterDoc(url, opts) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4');
  const link = String(url || '');
  const showBadge = !opts || opts.showBadge !== false;

  // --- fond + cadre ---------------------------------------------------------
  pdf.setFillColor(255, 255, 255);
  pdf.rect(0, 0, PAGE.w, PAGE.h, 'F');
  pdf.setDrawColor(...GREY_LINE);
  pdf.setLineWidth(0.4);
  pdf.roundedRect(M, M, INNER, PAGE.h - M * 2, 3, 3, 'S');

  // bandeau d'accent en haut du cadre (arrondi en haut, a plat en bas)
  pdf.setFillColor(...ACC);
  pdf.roundedRect(M, M, INNER, 6, 3, 3, 'F');
  pdf.rect(M, M + 3, INNER, 3, 'F');

  // --- accroche -------------------------------------------------------------
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9.5);
  pdf.setTextColor(...GREY_TEXT);
  charSpace(pdf, 1.2);
  pdf.text('AVANT LA COURSE  ·  APRES LA COURSE', CX, 44, { align: 'center' });
  charSpace(pdf, 0);

  pdf.setFontSize(34);
  pdf.setTextColor(...DARK);
  pdf.text('SCANNEZ CE CODE', CX, 60, { align: 'center' });

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(12);
  pdf.setTextColor(...BODY);
  pdf.splitTextToSize(
    'Inscrivez-vous à la session et retrouvez vos temps, votre classement et les records du circuit.',
    135
  ).forEach((line, i) => pdf.text(line, CX, 72 + i * 6.5, { align: 'center' }));

  // --- QR + equerres --------------------------------------------------------
  // qrCanvas() inclut deja la zone de silence de 4 modules DANS l'image : les
  // equerres sont donc posees au bord du canvas, jamais sur le motif.
  const QS = 100;                    // ~80 mm de motif noir utile : scannable a ~2,5 m (regle des 10 x la taille)
  const qx = CX - QS / 2, qy = 88;
  let canvas = null;
  try { canvas = qrCanvas(link, 1100); } catch (e) { canvas = null; }
  if (canvas) pdf.addImage(canvas.toDataURL('image/png'), 'PNG', qx, qy, QS, QS, undefined, 'FAST');

  const L = 12, T = 1.2;
  pdf.setFillColor(...ACC);
  [[qx, qy, 1, 1], [qx + QS, qy, -1, 1], [qx, qy + QS, 1, -1], [qx + QS, qy + QS, -1, -1]]
    .forEach(([x, y, sx, sy]) => {
      pdf.rect(sx > 0 ? x : x - L, sy > 0 ? y : y - T, L, T, 'F');
      pdf.rect(sx > 0 ? x : x - T, sy > 0 ? y : y - L, T, L, 'F');
    });

  // --- rappel + adresse en clair (pour qui ne scanne pas) -------------------
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10.5);
  pdf.setTextColor(...GREY_TEXT);
  pdf.text("Ouvrez simplement l'appareil photo de votre téléphone", CX, 198, { align: 'center' });
  pdf.setFontSize(8);
  pdf.setTextColor(...FAINT);
  pdf.text(link.replace(/^https?:\/\//, ''), CX, 204, { align: 'center' });

  // --- les 3 etapes ---------------------------------------------------------
  const steps = [
    'Vous scannez, aucune application à installer',
    'Vous vous inscrivez en 20 secondes',
    'Vos résultats arrivent par e-mail'
  ];
  const cols = [56, CX, 154], sy0 = 231;
  steps.forEach((txt, i) => {
    pdf.setFillColor(...ACC);
    pdf.circle(cols[i], sy0, 4.5, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.text(String(i + 1), cols[i], sy0 + 1.7, { align: 'center' });

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(...BODY);
    pdf.splitTextToSize(txt, 42).forEach((line, j) =>
      pdf.text(line, cols[i], sy0 + 10.5 + j * 4.4, { align: 'center' }));
  });

  // --- pied de page ---------------------------------------------------------
  if (showBadge) {
    pdf.setDrawColor(...GREY_LINE);
    pdf.setLineWidth(0.25);
    pdf.line(M + 12, 269, PAGE.w - M - 12, 269);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8.2);
    pdf.setTextColor(...FAINT);
    charSpace(pdf, 0.5);
    pdf.text('PROPULSE PAR TRINISETTE  ·  TRINISETTE.FR', CX, 274.5, { align: 'center' });
    charSpace(pdf, 0);
  }

  return pdf;
}

/** Telecharge l'affiche. */
export function saveVenuePoster(url, opts) {
  buildVenuePosterDoc(url, opts).save((opts && opts.fileName) || 'affiche-qr-circuit.pdf');
}
