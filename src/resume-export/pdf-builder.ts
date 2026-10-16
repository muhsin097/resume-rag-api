import PDFDocument from 'pdfkit';
import type { ResumeDocument } from '../llm/claude.client.js';

export function buildPdf(doc: ResumeDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    pdf.fontSize(20).fillColor('#000').text(doc.name);
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
        .text(section.heading.toUpperCase(), { underline: true });
      pdf.font('Helvetica');

      for (const item of section.items) {
        pdf.moveDown(0.4);
        const header = item.subtitle ? `${item.title} — ${item.subtitle}` : item.title;
        pdf.fontSize(11).font('Helvetica-Bold').text(header);
        pdf.font('Helvetica').fontSize(10);
        for (const bullet of item.bullets) {
          pdf.text(`•  ${bullet}`, { indent: 14 });
        }
      }
    }

    pdf.end();
  });
}
