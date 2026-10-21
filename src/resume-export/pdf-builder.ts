import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ResumeDocument } from '../llm/claude.client.js';

// A lighter tint of the web app's --accent (#6D28D9) -- used only for the
// exported document's headings, not the site's own buttons/links, per the
// user's reference resume using a comparatively lighter heading color
// than our full-strength brand purple.
const ACCENT_COLOR = '#7C3AED';

// pdfkit only ships the 14 standard PDF fonts -- no Calibri/Cambria
// without embedding actual font files, and those are proprietary
// Microsoft fonts we can't legally bundle/redistribute. Carlito and
// Caladea are Google Fonts (SIL Open Font License), purpose-built as
// metric-compatible, visually-near-identical open replacements for
// Calibri and Cambria respectively -- safe to embed, and matches the
// user's own reference resume's Calibri/Cambria pairing far more closely
// than the Helvetica fallback used before.
const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
const HEADING_FONT = 'Carlito-Bold';
const BODY_FONT = 'Caladea';
const BODY_FONT_BOLD = 'Caladea-Bold';

function registerFonts(pdf: PDFKit.PDFDocument): void {
  pdf.registerFont('Carlito-Bold', path.join(FONTS_DIR, 'Carlito-Bold.ttf'));
  pdf.registerFont(BODY_FONT, path.join(FONTS_DIR, 'Caladea-Regular.ttf'));
  pdf.registerFont(BODY_FONT_BOLD, path.join(FONTS_DIR, 'Caladea-Bold.ttf'));
}

// Skills/Languages/Achievements items carry an empty title today, but
// older stored generations put the section heading itself in there --
// skip it either way rather than printing the heading twice.
function hasOwnItemTitle(
  item: { title: string },
  section: { heading: string },
): boolean {
  return Boolean(item.title) && item.title.trim().toLowerCase() !== section.heading.trim().toLowerCase();
}

export function buildPdf(doc: ResumeDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      margins: { top: 72, bottom: 72, left: 90, right: 90 },
    });
    registerFonts(pdf);
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    pdf.font(HEADING_FONT).fontSize(14).fillColor(ACCENT_COLOR).text(doc.name);
    if (doc.title) {
      pdf.font(BODY_FONT).fontSize(11).fillColor('#000').text(doc.title);
    }
    pdf.font(BODY_FONT).fontSize(10).fillColor('#555555').text(doc.contactLine);
    pdf.fillColor('#000');

    if (doc.summary) {
      pdf.moveDown(0.8);
      pdf
        .font(HEADING_FONT)
        .fontSize(13)
        .fillColor(ACCENT_COLOR)
        .text('PROFESSIONAL SUMMARY');
      pdf.fillColor('#000');
      pdf.moveDown(0.3);
      pdf.font(BODY_FONT).fontSize(11).text(doc.summary, { lineGap: 3 });
    }

    for (const section of doc.sections) {
      pdf.moveDown(1.2);
      pdf
        .font(HEADING_FONT)
        .fontSize(13)
        .fillColor(ACCENT_COLOR)
        .text(section.heading.toUpperCase());
      pdf.fillColor('#000');
      pdf.moveDown(0.3);

      for (const item of section.items) {
        if (section.heading === 'Skills') {
          // One category per line ("Category: skill, skill, skill") rather
          // than a bullet per skill or one giant comma-separated line --
          // wraps naturally regardless of length, and groups read like a
          // normal resume Skills section. Unlabeled (no category assigned
          // yet) items just render their list with no leading label.
          if (item.bullets.length === 0) continue;
          pdf.moveDown(0.3);
          if (item.title) {
            pdf
              .font(BODY_FONT_BOLD)
              .fontSize(11)
              .fillColor('#000')
              .text(`${item.title}: `, { continued: true, indent: 10, lineGap: 3 });
            pdf.font(BODY_FONT).fontSize(11).text(item.bullets.join(', '), { lineGap: 3 });
          } else {
            pdf.font(BODY_FONT).fontSize(11).text(item.bullets.join(', '), { indent: 10, lineGap: 3 });
          }
          continue;
        }

        pdf.moveDown(0.5);
        if (hasOwnItemTitle(item, section)) {
          // Dates get their own line rather than appended after the title
          // -- a long job/degree title plus a date range on one line
          // wraps awkwardly in the page's margins.
          pdf.font(BODY_FONT_BOLD).fontSize(11).fillColor('#000').text(item.title);
          if (item.subtitle) {
            pdf.font(BODY_FONT).fontSize(9).fillColor('#666666').text(item.subtitle);
            pdf.fillColor('#000');
          }
          pdf.moveDown(0.15);
        }
        pdf.font(BODY_FONT).fontSize(11);
        for (const bullet of item.bullets) {
          pdf.text(`•  ${bullet}`, { indent: 16, lineGap: 3 });
        }
      }
    }

    pdf.end();
  });
}
