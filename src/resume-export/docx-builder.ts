import { Document, Paragraph, TextRun, HeadingLevel, Packer } from 'docx';
import type { ResumeDocument } from '../llm/claude.client.js';

export function buildDocx(doc: ResumeDocument): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: doc.name, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: doc.contactLine, color: '555555' })] }),
  ];

  if (doc.summary) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ text: doc.summary }));
  }

  for (const section of doc.sections) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    for (const item of section.items) {
      const header = item.subtitle ? `${item.title} — ${item.subtitle}` : item.title;
      children.push(new Paragraph({ children: [new TextRun({ text: header, bold: true })] }));
      for (const bullet of item.bullets) {
        children.push(new Paragraph({ text: bullet, bullet: { level: 0 } }));
      }
    }
  }

  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}
