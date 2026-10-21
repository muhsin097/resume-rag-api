import PDFDocument from 'pdfkit';
import type { ResumeDocument } from '../llm/claude.client.js';

// Matches the web app's --accent brand color, so the downloaded file
// visually matches the on-screen preview.
const ACCENT_COLOR = '#6D28D9';
// pdfkit only ships the 14 standard PDF fonts (no Geist Sans/Poppins
// without embedding TTFs we don't have), so this uses Helvetica throughout
// -- the closest built-in match to the web app's own clean sans-serif
// look, rather than the old Times-Roman serif body. Margins below match
// the user's own reference resume (1in top/bottom, 1.25in left/right).
const HEADING_FONT = 'Helvetica-Bold';
const BODY_FONT = 'Helvetica';
const BODY_FONT_BOLD = 'Helvetica-Bold';

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
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    pdf.font(HEADING_FONT).fontSize(20).fillColor('#000').text(doc.name);
    if (doc.title) {
      pdf.font(HEADING_FONT).fontSize(12).fillColor(ACCENT_COLOR).text(doc.title);
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
              .fontSize(10)
              .fillColor('#000')
              .text(`${item.title}: `, { continued: true, indent: 10, lineGap: 3 });
            pdf.font(BODY_FONT).fontSize(10).text(item.bullets.join(', '), { lineGap: 3 });
          } else {
            pdf.font(BODY_FONT).fontSize(10).text(item.bullets.join(', '), { indent: 10, lineGap: 3 });
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
        pdf.font(BODY_FONT).fontSize(10);
        for (const bullet of item.bullets) {
          pdf.text(`•  ${bullet}`, { indent: 16, lineGap: 3 });
        }
      }
    }

    pdf.end();
  });
}
