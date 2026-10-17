import { Document, Paragraph, TextRun, Packer, convertInchesToTwip } from 'docx';
import type { ResumeDocument } from '../llm/claude.client.js';

// Matches the web app's --accent brand color, so the downloaded file
// visually matches the on-screen preview.
const ACCENT_COLOR = '6D28D9';
// Heading/body font pairing and spacing values taken from the user's own
// reference resume (Calibri headings over Cambria body text, 1.15 line
// height, Letter page with 1in/1.25in margins) -- not arbitrary choices.
const HEADING_FONT = 'Calibri';
const BODY_FONT = 'Cambria';
const LINE_SPACING = { line: 276, lineRule: 'auto' as const };

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
      spacing: { after: 40, ...LINE_SPACING },
      children: [
        new TextRun({ text: doc.name, bold: true, size: 32, font: HEADING_FONT }),
      ],
    }),
  ];

  if (doc.title) {
    children.push(
      new Paragraph({
        spacing: { after: 40, ...LINE_SPACING },
        children: [
          new TextRun({ text: doc.title, bold: true, color: ACCENT_COLOR, size: 24, font: HEADING_FONT }),
        ],
      }),
    );
  }

  children.push(
    new Paragraph({
      spacing: { after: 200, ...LINE_SPACING },
      children: [new TextRun({ text: doc.contactLine, color: '555555', size: 20, font: BODY_FONT })],
    }),
  );

  if (doc.summary) {
    children.push(
      new Paragraph({
        spacing: { after: 200, ...LINE_SPACING },
        children: [new TextRun({ text: doc.summary, size: 22, font: BODY_FONT })],
      }),
    );
  }

  for (const section of doc.sections) {
    children.push(
      new Paragraph({
        spacing: { before: 240, after: 80, ...LINE_SPACING },
        children: [
          new TextRun({
            text: section.heading.toUpperCase(),
            bold: true,
            color: ACCENT_COLOR,
            size: 26,
            font: HEADING_FONT,
          }),
        ],
      }),
    );
    for (const item of section.items) {
      if (hasOwnItemTitle(item, section)) {
        // Dates get their own line rather than being appended after the
        // title -- a long job/degree title plus a date range on one line
        // wraps awkwardly, especially in the narrower page margins.
        children.push(
          new Paragraph({
            spacing: { after: item.subtitle ? 0 : 40, ...LINE_SPACING },
            children: [new TextRun({ text: item.title, bold: true, size: 22, font: BODY_FONT })],
          }),
        );
        if (item.subtitle) {
          children.push(
            new Paragraph({
              spacing: { after: 40, ...LINE_SPACING },
              children: [new TextRun({ text: item.subtitle, color: '666666', size: 18, font: BODY_FONT })],
            }),
          );
        }
      }
      for (const bullet of item.bullets) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 40, ...LINE_SPACING },
            children: [new TextRun({ text: bullet, size: 22, font: BODY_FONT })],
          }),
        );
      }
    }
  }

  const document = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1.25),
              right: convertInchesToTwip(1.25),
            },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
