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
    const totalMfa = parseFloat(snap.user_mfa_percentage || snap.mfa_percentage || 0) / 100 * snap.user_count;
    const adminMfa = parseFloat(snap.admin_mfa_percentage || snap.mfa_percentage || 0) / 100 * (snap.admin_count || 0);
    nonAdminMfaPercentage = Math.round((totalMfa - adminMfa) / nonAdminCount * 10000) / 100;
  }
  return {
    nonAdminCount,
    nonAdminMfaPercentage: nonAdminMfaPercentage ?? 0
  };
}
export async function generateCampaignReportPDF(campaign, startSnapshot, endSnapshot, comparison, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: MARGIN,
        autoFirstPage: true
      });
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);
      let y = 0;
      const coverTextTop = 280;
      doc.save();
      doc.lineWidth(1);
      doc.strokeColor('#e5e7eb');
      doc.opacity(0.08);
      const hexRadius = 38;
      const hexHeight = Math.sqrt(3) * hexRadius;
      const hexWidth = 2 * hexRadius;
      const cols = Math.ceil(PAGE_WIDTH / (hexWidth * 0.75));
      const honeycombRows = Math.ceil(PAGE_HEIGHT / hexHeight);
      for (let row = 0; row < honeycombRows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = MARGIN + col * hexWidth * 0.75;
          const hy = MARGIN + row * hexHeight + (col % 2 === 0 ? 0 : hexHeight / 2);
          const hexPoints = [];
          for (let i = 0; i < 6; i++) {
            const angle = Math.PI / 3 * i;
            hexPoints.push([x + hexRadius * Math.cos(angle), hy + hexRadius * Math.sin(angle)]);
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
      y = coverTextTop;
      const textOffset = 40;
      doc.font('Helvetica-Bold').fontSize(22).fillColor('#1a1a2e').text('Cybersecurity campaign report', textOffset, y, {
        align: 'center',
        width: PAGE_WIDTH - textOffset
      });
      y += 32;
      doc.font('Helvetica').fontSize(14).fillColor('#333').text('Microsoft Security — Adoption MFA', textOffset, y, {
        align: 'center',
        width: PAGE_WIDTH - textOffset
      });
      y += 32;
      doc.font('Helvetica').fontSize(12).fillColor('#333').text(`Client: ${campaign.client_name || `Client ${campaign.client_id}`}`, textOffset, y, {
        align: 'center',
        width: PAGE_WIDTH - textOffset
      });
      y += 18;
      doc.text(`Campaign: ${campaign.name || '—'}`, textOffset, y, {
        align: 'center',
        width: PAGE_WIDTH - textOffset
      });
      y += 18;
      doc.text(`Period: ${new Date(startSnapshot.created_at).toLocaleDateString('en-US')} to ${new Date(endSnapshot.created_at).toLocaleDateString('en-US')}`, textOffset, y, {
        align: 'center',
        width: PAGE_WIDTH - textOffset
      });
      y += 32;
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#888').text('Confidential document — Do not distribute without authorization', textOffset, y, {
        align: 'center',
        width: PAGE_WIDTH - textOffset
      });
      const yLogos = PAGE_HEIGHT - 60;
      const logoCnil = path.join(__dirname, '../../veritas-frontend/public/assets/logo/cnil.png');
      const logoAnssi = path.join(__dirname, '../../veritas-frontend/public/assets/logo/anssi.png');
      if (fs.existsSync(logoCnil)) {
        doc.image(logoCnil, PAGE_WIDTH / 2 - 90, yLogos + 40, {
          width: 50
        });
      }
      if (fs.existsSync(logoAnssi)) {
        doc.image(logoAnssi, PAGE_WIDTH / 2 + 40, yLogos, {
          width: 50
        });
      }
      doc.addPage();
      doc.y += 60;
      const startExtra = parseSnapshotExtra(startSnapshot);
      const endExtra = parseSnapshotExtra(endSnapshot);
      doc.rect(0, 0, PAGE_WIDTH, 32).fill('#1a1a2e');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text('OFFICIAL DOCUMENT', 0, 10, {
        width: PAGE_WIDTH,
        align: 'center'
      });
      doc.fillColor('#000000');
      doc.y = 50;
      doc.font('Helvetica-Bold').fontSize(18).text('Cybersecurity campaign report', MARGIN, doc.y, {
        align: 'left'
      });
      doc.moveDown(1.2);
      doc.font('Helvetica').fontSize(12).text('Microsoft Security — Adoption MFA', MARGIN, doc.y, {
        align: 'left'
      });
      doc.moveDown(0.8);
      doc.rect(MARGIN, doc.y, CONTENT_WIDTH, 58).stroke('#cccccc');
      doc.moveDown(0.3);
      const blockTop = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).text('Campaign', MARGIN + 12, blockTop + 8);
      doc.font('Helvetica').fontSize(10).text(campaign.name || '—', MARGIN + 12, blockTop + 22).text(`Client: ${campaign.client_name || `Client ${campaign.client_id}`}`, MARGIN + 12, blockTop + 36);
      doc.font('Helvetica').fontSize(9).fillColor('#555555').text(`Generated on ${new Date().toLocaleString('en-US', {
        dateStyle: 'long',
        timeStyle: 'short'
      })}`, MARGIN + CONTENT_WIDTH - 180, blockTop + 22, {
        width: 170,
        align: 'right'
      });
      doc.fillColor('#000000');
      doc.y = blockTop + 62;
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(12).text('1. Executive summary', MARGIN, doc.y, {
        underline: true,
        align: 'left'
      });
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(10);
      const startDate = new Date(startSnapshot.created_at).toLocaleDateString('en-US');
      const endDate = new Date(endSnapshot.created_at).toLocaleDateString('en-US');
      const durationDays = Math.max(0, Math.ceil((new Date(endSnapshot.created_at) - new Date(startSnapshot.created_at)) / (1000 * 60 * 60 * 24)));
      const mfaChange = comparison.mfaPercentage.change;
      const mfaChangeStr = mfaChange > 0 ? `+${mfaChange.toFixed(2)}` : mfaChange.toFixed(2);
      doc.text(`Report period: ${startDate} to ${endDate} (${durationDays} day${durationDays !== 1 ? 's' : ''}).`, MARGIN, doc.y, {
        align: 'left'
      });
      doc.moveDown(0.25);
      if (campaign.objectif_adoption !== undefined && campaign.objectif_adoption !== null && campaign.objectif_adoption !== '' && !isNaN(Number(campaign.objectif_adoption))) {
        doc.text(`Adoption target: ${Number(campaign.objectif_adoption).toFixed(2)} %`, MARGIN, doc.y, {
          align: 'left'
        });
        doc.moveDown(0.25);
      }
      doc.text(`Overall MFA rate change: ${mfaChangeStr} %.`, MARGIN, doc.y, {
        align: 'left'
      });
      doc.moveDown(0.25);
      doc.text(`Users (total): ${comparison.userCount.start} → ${comparison.userCount.end} (${comparison.userCount.change >= 0 ? '+' : ''}${comparison.userCount.change})`, MARGIN, doc.y, {
        align: 'left'
      });
      doc.moveDown(0.25);
      doc.text(`Administrators: ${comparison.adminCount.start} → ${comparison.adminCount.end} (${comparison.adminCount.change >= 0 ? '+' : ''}${comparison.adminCount.change})`, MARGIN, doc.y, {
        align: 'left'
      });
      doc.moveDown(1);
      doc.font('Helvetica-Bold').fontSize(12).text('2. Start and end snapshots', MARGIN, doc.y, {
        underline: true,
        align: 'left'
      });
      doc.moveDown(0.5);
      const colWidth = CONTENT_WIDTH / 2;
      const labelW = 90;
      const valueW = 60;
      function writeSnapshotBlock(label, snap, extra, x, yStart) {
        doc.font('Helvetica-Bold').fontSize(10).text(label, x, yStart);
        doc.font('Helvetica').fontSize(9);
        let y = yStart + 16;
        doc.text(`Date: ${new Date(snap.created_at).toLocaleDateString('en-US')}`, x, y);
        y += 14;
        doc.text('Total users:', x, y);
        doc.text(String(snap.user_count), x + labelW, y);
        y += 12;
        doc.text('Total MFA:', x, y);
        doc.text(String(snap.mfa_enabled_count), x + labelW, y);
        y += 12;
        doc.text('Admins :', x, y);
        doc.text(String(snap.admin_count), x + labelW, y);
        y += 12;
        doc.text('MFA admins :', x, y);
        doc.text(`${parseFloat(snap.admin_mfa_percentage || snap.mfa_percentage || 0).toFixed(2)} %`, x + labelW, y);
        y += 12;
        doc.text('Non admin :', x, y);
        doc.text(String(extra.nonAdminCount), x + labelW, y);
        y += 12;
        doc.text('MFA non admin :', x, y);
        doc.text(`${extra.nonAdminMfaPercentage.toFixed(2)} %`, x + labelW, y);
        y += 12;
        doc.text('MFA enabled:', x, y);
        doc.text(String(snap.mfa_enabled_count), x + labelW, y);
        y += 12;
        doc.text('Without MFA:', x, y);
        doc.text(String(snap.mfa_disabled_count), x + labelW, y);
        return yStart + 120;
      }
      const snapY = doc.y;
      writeSnapshotBlock('Start', startSnapshot, startExtra, MARGIN, snapY);
      writeSnapshotBlock('End', endSnapshot, endExtra, MARGIN + colWidth, snapY);
      doc.y = snapY + 102;
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(12).text('3. Comparison table', MARGIN, doc.y, {
        underline: true,
        align: 'left'
      });
      doc.moveDown(0.4);
      const tableLeft = MARGIN;
      const rowH = 20;
      const cw = [140, 90, 90, 90];
      let ty = doc.y;
      doc.font('Helvetica-Bold').fontSize(9);
      doc.rect(tableLeft, ty - 4, cw[0] + cw[1] + cw[2] + cw[3], rowH + 4).fill('#f0f0f0').stroke();
      doc.fillColor('#000000').text('Metric', tableLeft + 6, ty + 2).text('Start', tableLeft + cw[0] + 6, ty + 2).text('End', tableLeft + cw[0] + cw[1] + 6, ty + 2).text('Change', tableLeft + cw[0] + cw[1] + cw[2] + 6, ty + 2);
      ty += rowH;
      doc.font('Helvetica').fontSize(9);
      const tableRows = [['Users (total)', String(startSnapshot.user_count), String(endSnapshot.user_count), `${comparison.userCount.change >= 0 ? '+' : ''}${comparison.userCount.change}`], ['Total MFA', String(startSnapshot.mfa_enabled_count), String(endSnapshot.mfa_enabled_count), `${comparison.mfaEnabledCount.change >= 0 ? '+' : ''}${comparison.mfaEnabledCount.change}`], ['Administrators', String(startSnapshot.admin_count), String(endSnapshot.admin_count), `${comparison.adminCount.change >= 0 ? '+' : ''}${comparison.adminCount.change}`], ['MFA admins (%)', `${parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0).toFixed(2)} %`, `${parseFloat(endSnapshot.admin_mfa_percentage || endSnapshot.mfa_percentage || 0).toFixed(2)} %`, `${(parseFloat(endSnapshot.admin_mfa_percentage || endSnapshot.mfa_percentage || 0) - parseFloat(startSnapshot.admin_mfa_percentage || startSnapshot.mfa_percentage || 0)).toFixed(2)} %`], ['Non admin', String(startExtra.nonAdminCount), String(endExtra.nonAdminCount), `${endExtra.nonAdminCount - startExtra.nonAdminCount >= 0 ? '+' : ''}${endExtra.nonAdminCount - startExtra.nonAdminCount}`], ['MFA non admin (%)', `${startExtra.nonAdminMfaPercentage.toFixed(2)} %`, `${endExtra.nonAdminMfaPercentage.toFixed(2)} %`, `${(endExtra.nonAdminMfaPercentage - startExtra.nonAdminMfaPercentage).toFixed(2)} %`], ['MFA enabled', String(startSnapshot.mfa_enabled_count), String(endSnapshot.mfa_enabled_count), `${comparison.mfaEnabledCount.change >= 0 ? '+' : ''}${comparison.mfaEnabledCount.change}`], ['Without MFA', String(startSnapshot.mfa_disabled_count), String(endSnapshot.mfa_disabled_count), `${endSnapshot.mfa_disabled_count - startSnapshot.mfa_disabled_count >= 0 ? '+' : ''}${endSnapshot.mfa_disabled_count - startSnapshot.mfa_disabled_count}`]];
      tableRows.forEach((row, i) => {
        doc.rect(tableLeft, ty - 2, cw[0] + cw[1] + cw[2] + cw[3], rowH).stroke();
        doc.text(row[0], tableLeft + 6, ty + 4).text(row[1], tableLeft + cw[0] + 6, ty + 4).text(row[2], tableLeft + cw[0] + cw[1] + 6, ty + 4).text(row[3], tableLeft + cw[0] + cw[1] + cw[2] + 6, ty + 4);
        ty += rowH;
      });
      doc.y = ty + 12;
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(12).text('4. Changes', MARGIN, doc.y, {
        underline: true,
        align: 'left'
      });
      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(10);
      doc.text(`• MFA rate: ${mfaChangeStr} %`, MARGIN, doc.y, {
        align: 'left'
      });
      doc.text(`• Users (total): ${comparison.userCount.change >= 0 ? '+' : ''}${comparison.userCount.change}`, MARGIN, doc.y, {
        align: 'left'
      });
      doc.text(`• Administrators: ${comparison.adminCount.change >= 0 ? '+' : ''}${comparison.adminCount.change}`, MARGIN, doc.y, {
        align: 'left'
      });
      doc.text(`• MFA enabled: ${comparison.mfaEnabledCount.change >= 0 ? '+' : ''}${comparison.mfaEnabledCount.change}`, MARGIN, doc.y, {
        align: 'left'
      });
      doc.moveDown(1);
      const footerY = PAGE_HEIGHT - MARGIN - 24;
      doc.rect(0, footerY, PAGE_WIDTH, 24).fill('#f5f5f5').stroke('#ddd');
      doc.fillColor('#333333').font('Helvetica').fontSize(9).text('Official document', MARGIN, footerY + 6).text(`Generated on ${new Date().toLocaleString('en-US')}`, MARGIN, footerY + 18);
      doc.text('Cybersecurity campaign report — Do not distribute without authorization.', PAGE_WIDTH - MARGIN - 320, footerY + 12, {
        width: 320,
        align: 'right'
      });
      doc.fillColor('#000000');
      stream.on('finish', () => resolve(outputPath));
      stream.on('error', err => reject(err));
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
