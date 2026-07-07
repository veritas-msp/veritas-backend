// ───────────────────────────────────────────────
// 📄 Générateur de rapports PDF pour les campagnes
// Rapport officiel — mise en page professionnelle
// ───────────────────────────────────────────────
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function parseSnapshotExtra(snap) {
  let nonAdminCount = (snap.user_count || 0) - (snap.admin_count || 0);
  let nonAdminMfaPercentage = null;
  try {
    const data = typeof snap.snapshot_data === 'string' ? JSON.parse(snap.snapshot_data) : snap.snapshot_data;
    if (data) {
      if (data.nonAdminCount != null) nonAdminCount = data.nonAdminCount;
      if (data.nonAdminMfaPercentage != null) nonAdminMfaPercentage = parseFloat(data.nonAdminMfaPercentage);
    }
  } catch (_) {}
  if (nonAdminMfaPercentage == null && nonAdminCount > 0 && snap.user_count > 0) {
    const totalMfa = (parseFloat(snap.user_mfa_percentage || snap.mfa_percentage || 0) / 100) * snap.user_count;
    const adminMfa = (parseFloat(snap.admin_mfa_percentage || snap.mfa_percentage || 0) / 100) * (snap.admin_count || 0);
    nonAdminMfaPercentage = Math.round(((totalMfa - adminMfa) / nonAdminCount) * 10000) / 100;
  }
  return { nonAdminCount, nonAdminMfaPercentage: nonAdminMfaPercentage ?? 0 };
}

/**
 * Génère un rapport PDF officiel pour une campagne Microsoft Security
 */
export async function generateCampaignReportPDF(campaign, startSnapshot, endSnapshot, comparison, outputPath) {

  return new Promise((resolve, reject) => {
    try {
      // Motif nid d'abeille hexagonal en background (faible opacité)
      doc.save();
      doc.lineWidth(1);
      doc.strokeColor('#e5e7eb');
      doc.opacity(0.08);
      const hexRadius = 38;
      const hexHeight = Math.sqrt(3) * hexRadius;
      const hexWidth = 2 * hexRadius;
      const cols = Math.ceil(PAGE_WIDTH / (hexWidth * 0.75));
      const honeycombRows = Math.ceil(PAGE_HEIGHT / (hexHeight));
      for (let row = 0; row < honeycombRows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = MARGIN + col * hexWidth * 0.75;
          const y = MARGIN + row * hexHeight + (col % 2 === 0 ? 0 : hexHeight / 2);
          const hexPoints = [];
          for (let i = 0; i < 6; i++) {
            const angle = Math.PI / 3 * i;
            hexPoints.push([
              x + hexRadius * Math.cos(angle),
              y + hexRadius * Math.sin(angle)
            ]);
          }
          doc.moveTo(hexPoints[0][0], hexPoints[0][1]);
          for (let i = 1; i < 6; i++) {
            doc.lineTo(hexPoints[i][0], hexPoints[i][1]);
          }
          doc.closePath();
          doc.fillAndStroke('#e5e7eb', '#e5e7eb');
        }
      }
      doc.restore();
      // Centered text
      y = coverTextTop;
      const textOffset = 40; // Décale le texte vers la droite
      doc.font('Helvetica-Bold').fontSize(22).fillColor('#1a1a2e')
        .text('Rapport de campagne cybersécurité', textOffset, y, { align: 'center', width: PAGE_WIDTH - textOffset });
      y += 32;
      doc.font('Helvetica').fontSize(14).fillColor('#333')
        .text('Microsoft Security — Adoption MFA', textOffset, y, { align: 'center', width: PAGE_WIDTH - textOffset });
      y += 32;
      doc.font('Helvetica').fontSize(12).fillColor('#333')
        .text(`Client : ${campaign.client_name || `Client ${campaign.client_id}`}`, textOffset, y, { align: 'center', width: PAGE_WIDTH - textOffset });
      y += 18;
      doc.text(`Campagne : ${campaign.name || '—'}`, textOffset, y, { align: 'center', width: PAGE_WIDTH - textOffset });
      y += 18;
      doc.text(`Période : du ${new Date(startSnapshot.created_at).toLocaleDateString('fr-FR')} au ${new Date(endSnapshot.created_at).toLocaleDateString('fr-FR')}`, textOffset, y, { align: 'center', width: PAGE_WIDTH - textOffset });
      y += 32;
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#888')
        .text('Document confidentiel — Ne pas diffuser sans autorisation', textOffset, y, { align: 'center', width: PAGE_WIDTH - textOffset });

      // Logos officiels en bas de page (PSI, CNIL, ANSSI)
      const yLogos = PAGE_HEIGHT - 60;
      const logoCnil = path.join(__dirname, '../../veritas-frontend/public/assets/logo/cnil.png');
      const logoAnssi = path.join(__dirname, '../../veritas-frontend/public/assets/logo/anssi.png');
      if (fs.existsSync(logoCnil)) {
        doc.image(logoCnil, PAGE_WIDTH/2 - 90, yLogos + 40, { width: 50 }); // Descend encore plus le logo CNIL
      }
      if (fs.existsSync(logoAnssi)) {
        doc.image(logoAnssi, PAGE_WIDTH/2 + 40, yLogos, { width: 50 });
      }
      // PSI logo déjà centré en haut

      doc.addPage();
      doc.y += 60; // Ajoute un espace plus grand au-dessus du titre sur la seconde page

      // ────────────────
      // 2. RAPPORT DÉTAILLÉ (identique à l'ancien)
      // ────────────────
      const startExtra = parseSnapshotExtra(startSnapshot);
      const endExtra = parseSnapshotExtra(endSnapshot);

      // Bandeau OFFICIEL (haut de page)
      doc.rect(0, 0, PAGE_WIDTH, 32).fill('#1a1a2e');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
        .text('DOCUMENT OFFICIEL', 0, 10, { width: PAGE_WIDTH, align: 'center' });
      doc.fillColor('#000000');
      doc.y = 50;

      // Titre principal
      doc.font('Helvetica-Bold').fontSize(18)
        .text('Rapport de campagne cybersécurité', MARGIN, doc.y, { align: 'left' });
      doc.moveDown(1.2); // Ajoute un espace au-dessus de 1. Résumé exécutif
      doc.font('Helvetica').fontSize(12)
        .text('Microsoft Security — Adoption MFA', MARGIN, doc.y, { align: 'left' });
      doc.moveDown(0.8);

      // Bloc identité campagne / client
      doc.rect(MARGIN, doc.y, CONTENT_WIDTH, 58).stroke('#cccccc');
      doc.moveDown(0.3);
      const blockTop = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).text('Campagne', MARGIN + 12, blockTop + 8);
      doc.font('Helvetica').fontSize(10)
        .text(campaign.name || '—', MARGIN + 12, blockTop + 22)
        .text(`Client : ${campaign.client_name || `Client ${campaign.client_id}`}`, MARGIN + 12, blockTop + 36);
      doc.font('Helvetica').fontSize(9).fillColor('#555555')
        .text(`Généré le ${new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}`, MARGIN + CONTENT_WIDTH - 180, blockTop + 22, { width: 170, align: 'right' });
      doc.fillColor('#000000');
      doc.y = blockTop + 62;
      doc.moveDown(0.8);

      // Résumé exécutif
      doc.font('Helvetica-Bold').fontSize(12)
        .text('1. Résumé exécutif', MARGIN, doc.y, { underline: true, align: 'left' });
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(10);

      const startDate = new Date(startSnapshot.created_at).toLocaleDateString('fr-FR');
      const endDate = new Date(endSnapshot.created_at).toLocaleDateString('fr-FR');
      const durationDays = Math.max(0, Math.ceil((new Date(endSnapshot.created_at) - new Date(startSnapshot.created_at)) / (1000 * 60 * 60 * 24)));
      const mfaChange = comparison.mfaPercentage.change;
      const mfaChangeStr = mfaChange > 0 ? `+${mfaChange.toFixed(2)}` : mfaChange.toFixed(2);

      doc.text(`Période du rapport : du ${startDate} au ${endDate} (${durationDays} jour${durationDays > 1 ? 's' : ''}).`, MARGIN, doc.y, { align: 'left' });
      doc.moveDown(0.25);
      if (campaign.objectif_adoption !== undefined && campaign.objectif_adoption !== null && campaign.objectif_adoption !== '' && !isNaN(Number(campaign.objectif_adoption))) {
        doc.text(`Objectif d'adoption : ${Number(campaign.objectif_adoption).toFixed(2)} %`, MARGIN, doc.y, { align: 'left' });
        doc.moveDown(0.25);
      }
      doc.text(`Évolution du taux MFA global : ${mfaChangeStr} %.`, MARGIN, doc.y, { align: 'left' });
      doc.moveDown(0.25);
      doc.text(`Utilisateurs (total) : ${comparison.userCount.start} → ${comparison.userCount.end} (${comparison.userCount.change >= 0 ? '+' : ''}${comparison.userCount.change})`, MARGIN, doc.y, { align: 'left' });
      doc.moveDown(0.25);
      doc.text(`Administrateurs : ${comparison.adminCount.start} → ${comparison.adminCount.end} (${comparison.adminCount.change >= 0 ? '+' : ''}${comparison.adminCount.change})`, MARGIN, doc.y, { align: 'left' });
      doc.moveDown(1);

      // Snapshots Début / Fin
      doc.font('Helvetica-Bold').fontSize(12)
        .text('2. Snapshots Début et Fin', MARGIN, doc.y, { underline: true, align: 'left' });
      doc.moveDown(0.5);

      const colWidth = CONTENT_WIDTH / 2;
      const labelW = 90;
      const valueW = 60;

      function writeSnapshotBlock(label, snap, extra, x, yStart) {
        doc.font('Helvetica-Bold').fontSize(10).text(label, x, yStart);
        doc.font('Helvetica').fontSize(9);
        let y = yStart + 16;
        doc.text(`Date : ${new Date(snap.created_at).toLocaleDateString('fr-FR')}`, x, y); y += 14;
        doc.text('Total utilisateurs :', x, y); doc.text(String(snap.user_count), x + labelW, y); y += 12;
        doc.text('Total MFA :', x, y); doc.text(String(snap.mfa_enabled_count), x + labelW, y); y += 12;
        doc.text('Admins :', x, y); doc.text(String(snap.admin_count), x + labelW, y); y += 12;
        doc.text('MFA admins :', x, y); doc.text(`${(parseFloat(snap.admin_mfa_percentage || snap.mfa_percentage || 0)).toFixed(2)} %`, x + labelW, y); y += 12;
        doc.text('Non admin :', x, y); doc.text(String(extra.nonAdminCount), x + labelW, y); y += 12;
        doc.text('MFA non admin :', x, y); doc.text(`${extra.nonAdminMfaPercentage.toFixed(2)} %`, x + labelW, y); y += 12;
        doc.text('MFA activé :', x, y); doc.text(String(snap.mfa_enabled_count), x + labelW, y); y += 12;
        doc.text('Sans MFA :', x, y); doc.text(String(snap.mfa_disabled_count), x + labelW, y);
        return yStart + 120;
      }

      const snapY = doc.y;
      writeSnapshotBlock('Début', startSnapshot, startExtra, MARGIN, snapY);
      writeSnapshotBlock('Fin', endSnapshot, endExtra, MARGIN + colWidth, snapY);
      doc.y = snapY + 102;
      doc.moveDown(0.8);

      // Tableau comparatif
      doc.font('Helvetica-Bold').fontSize(12)
        .text('3. Tableau comparatif', MARGIN, doc.y, { underline: true, align: 'left' });
      doc.moveDown(0.4);

      const tableLeft = MARGIN;
      const rowH = 20;
      const cw = [140, 90, 90, 90];

      let ty = doc.y;
      doc.font('Helvetica-Bold').fontSize(9);
      doc.rect(tableLeft, ty - 4, cw[0] + cw[1] + cw[2] + cw[3], rowH + 4).fill('#f0f0f0').stroke();
      doc.fillColor('#000000')
        .text('Métrique', tableLeft + 6, ty + 2)
        .text('Début', tableLeft + cw[0] + 6, ty + 2)
        .text('Fin', tableLeft + cw[0] + cw[1] + 6, ty + 2)
        .text('Évolution', tableLeft + cw[0] + cw[1] + cw[2] + 6, ty + 2);
      ty += rowH;

      doc.font('Helvetica').fontSize(9);
      const tableRows = [
        ['Utilisateurs (total)', String(startSnapshot.user_count), String(endSnapshot.user_count), `${comparison.userCount.change >= 0 ? '+' : ''}${comparison.userCount.change}`],
        ['Total MFA', String(startSnapshot.mfa_enabled_count), String(endSnapshot.mfa_enabled_count), `${comparison.mfaEnabledCount.change >= 0 ? '+' : ''}${comparison.mfaEnabledCount.change}`],
        ['Administrateurs', String(startSnapshot.admin_count), String(endSnapshot.admin_count), `${comparison.adminCount.change >= 0 ? '+' : ''}${comparison.adminCount.change}`],
        ['MFA admins (%)', `${(parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0)).toFixed(2)} %`, `${(parseFloat(endSnapshot.admin_mfa_percentage || endSnapshot.mfa_percentage || 0)).toFixed(2)} %`, `${((parseFloat(endSnapshot.admin_mfa_percentage || endSnapshot.mfa_percentage || 0)) - (parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0))).toFixed(2)} %`],
        ['Non admin', String(startExtra.nonAdminCount), String(endExtra.nonAdminCount), `${(endExtra.nonAdminCount - startExtra.nonAdminCount) >= 0 ? '+' : ''}${endExtra.nonAdminCount - startExtra.nonAdminCount}`],
        ['MFA non admin (%)', `${startExtra.nonAdminMfaPercentage.toFixed(2)} %`, `${endExtra.nonAdminMfaPercentage.toFixed(2)} %`, `${(endExtra.nonAdminMfaPercentage - startExtra.nonAdminMfaPercentage).toFixed(2)} %`],
        ['MFA activé', String(startSnapshot.mfa_enabled_count), String(endSnapshot.mfa_enabled_count), `${comparison.mfaEnabledCount.change >= 0 ? '+' : ''}${comparison.mfaEnabledCount.change}`],
        ['Sans MFA', String(startSnapshot.mfa_disabled_count), String(endSnapshot.mfa_disabled_count), `${(endSnapshot.mfa_disabled_count - startSnapshot.mfa_disabled_count) >= 0 ? '+' : ''}${endSnapshot.mfa_disabled_count - startSnapshot.mfa_disabled_count}`]
      ];
      tableRows.forEach((row, i) => {
        doc.rect(tableLeft, ty - 2, cw[0] + cw[1] + cw[2] + cw[3], rowH).stroke();
        doc.text(row[0], tableLeft + 6, ty + 4)
          .text(row[1], tableLeft + cw[0] + 6, ty + 4)
          .text(row[2], tableLeft + cw[0] + cw[1] + 6, ty + 4)
          .text(row[3], tableLeft + cw[0] + cw[1] + cw[2] + 6, ty + 4);
        ty += rowH;
      });
      doc.y = ty + 12;
      doc.moveDown(0.6);

      // Évolutions
      doc.font('Helvetica-Bold').fontSize(12)
        .text('4. Évolutions', MARGIN, doc.y, { underline: true, align: 'left' });
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(10);
      doc.text(`• Taux MFA : ${mfaChangeStr} %`, MARGIN, doc.y, { align: 'left' });
      doc.text(`• Utilisateurs (total) : ${comparison.userCount.change >= 0 ? '+' : ''}${comparison.userCount.change}`, MARGIN, doc.y, { align: 'left' });
      doc.text(`• Administrateurs : ${comparison.adminCount.change >= 0 ? '+' : ''}${comparison.adminCount.change}`, MARGIN, doc.y, { align: 'left' });
      doc.text(`• MFA activé : ${comparison.mfaEnabledCount.change >= 0 ? '+' : ''}${comparison.mfaEnabledCount.change}`, MARGIN, doc.y, { align: 'left' });
      doc.moveDown(1);

      // Pied de page : Document officiel
      const footerY = PAGE_HEIGHT - MARGIN - 24;
      doc.rect(0, footerY, PAGE_WIDTH, 24).fill('#f5f5f5').stroke('#ddd');
      doc.fillColor('#333333').font('Helvetica').fontSize(9)
        .text('Document officiel', MARGIN, footerY + 6)
        .text(`Généré le ${new Date().toLocaleString('fr-FR')}`, MARGIN, footerY + 18);
      doc.text('Rapport de campagne cybersécurité — Ne pas diffuser sans autorisation.', PAGE_WIDTH - MARGIN - 320, footerY + 12, { width: 320, align: 'right' });
      doc.fillColor('#000000');

      doc.end();

      stream.on('finish', () => resolve(outputPath));
      stream.on('error', (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}
