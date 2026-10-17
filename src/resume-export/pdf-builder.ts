import PDFDocument from 'pdfkit';
import type { ResumeDocument } from '../llm/claude.client.js';

// Matches the web app's --accent brand color, so the downloaded file
// visually matches the on-screen preview.
const ACCENT_COLOR = '#6D28D9';

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
    const pdf = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    pdf.fontSize(20).fillColor('#000').text(doc.name);
    if (doc.title) {
      pdf.fontSize(12).font('Helvetica-Bold').fillColor(ACCENT_COLOR).text(doc.title);
      pdf.font('Helvetica');
    }
    pdf.fontSize(10).fillColor('#555555').text(doc.contactLine);
    pdf.fillColor('#000');

    if (doc.summary) {
      pdf.moveDown(0.6);
      pdf.fontSize(11).text(doc.summary);
    }

    for (const section of doc.sections) {
      pdf.moveDown(1);
      pdf
        .fontSize(13)
        .font('Helvetica-Bold')
        .fillColor(ACCENT_COLOR)
        .text(section.heading.toUpperCase());
      pdf.font('Helvetica').fillColor('#000');

      for (const item of section.items) {
        pdf.moveDown(0.4);
        if (hasOwnItemTitle(item, section)) {
          const header = item.subtitle ? `${item.title} — ${item.subtitle}` : item.title;
          pdf.fontSize(11).font('Helvetica-Bold').text(header);
        }
        pdf.font('Helvetica').fontSize(10);
        for (const bullet of item.bullets) {
          pdf.text(`•  ${bullet}`, { indent: 14 });
        }
      }
    }

    pdf.end();
  });
}
