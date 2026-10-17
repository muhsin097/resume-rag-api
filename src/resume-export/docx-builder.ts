import { Document, Paragraph, TextRun, Packer } from 'docx';
import type { ResumeDocument } from '../llm/claude.client.js';

// Matches the web app's --accent brand color, so the downloaded file
// visually matches the on-screen preview.
const ACCENT_COLOR = '6D28D9';
const FONT = 'Calibri';

// Skills/Languages/Achievements items carry an empty title today, but
// older stored generations put the section heading itself in there --
// skip it either way rather than printing the heading twice.
function hasOwnItemTitle(
  item: { title: string },
  section: { heading: string },
): boolean {
  return Boolean(item.title) && item.title.trim().toLowerCase() !== section.heading.trim().toLowerCase();
}

export function buildDocx(doc: ResumeDocument): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: doc.name, bold: true, size: 32, font: FONT })],
    }),
  ];

  if (doc.title) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: doc.title, bold: true, color: ACCENT_COLOR, size: 22, font: FONT }),
        ],
      }),
    );
  }

  children.push(
    new Paragraph({
      children: [new TextRun({ text: doc.contactLine, color: '555555', font: FONT })],
    }),
  );

  if (doc.summary) {
    children.push(new Paragraph({ text: '' }));
    children.push(
      new Paragraph({ children: [new TextRun({ text: doc.summary, font: FONT })] }),
    );
  }

  for (const section of doc.sections) {
    children.push(new Paragraph({ text: '' }));
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: section.heading.toUpperCase(),
            bold: true,
            color: ACCENT_COLOR,
            size: 26,
            font: FONT,
          }),
        ],
      }),
    );
    for (const item of section.items) {
      if (hasOwnItemTitle(item, section)) {
        const header = item.subtitle ? `${item.title} — ${item.subtitle}` : item.title;
        children.push(
          new Paragraph({
            children: [new TextRun({ text: header, bold: true, font: FONT })],
          }),
        );
      }
      for (const bullet of item.bullets) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text: bullet, font: FONT })],
          }),
        );
      }
    }
  }

  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}
