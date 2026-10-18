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
      pdf.moveDown(0.6);
      pdf.font(BODY_FONT).fontSize(11).text(doc.summary, { lineGap: 2 });
    }

    for (const section of doc.sections) {
      pdf.moveDown(1);
      pdf
        .font(HEADING_FONT)
        .fontSize(13)
        .fillColor(ACCENT_COLOR)
        .text(section.heading.toUpperCase());
      pdf.fillColor('#000');

      for (const item of section.items) {
        pdf.moveDown(0.4);
        if (hasOwnItemTitle(item, section)) {
          // Dates get their own line rather than appended after the title
          // -- a long job/degree title plus a date range on one line
          // wraps awkwardly in the page's margins.
          pdf.font(BODY_FONT_BOLD).fontSize(11).fillColor('#000').text(item.title);
          if (item.subtitle) {
            pdf.font(BODY_FONT).fontSize(9).fillColor('#666666').text(item.subtitle);
            pdf.fillColor('#000');
          }
        }
        pdf.font(BODY_FONT).fontSize(10);
        if (section.heading === 'Skills' && item.bullets.length > 0) {
          // One combined, comma-separated line rather than a bullet per
          // skill -- wraps naturally no matter how many/long the skills are.
          pdf.text(item.bullets.join(', '), { lineGap: 2 });
        } else {
          for (const bullet of item.bullets) {
            pdf.text(`•  ${bullet}`, { indent: 14, lineGap: 2 });
          }
        }
      }
    }

    pdf.end();
  });
}
