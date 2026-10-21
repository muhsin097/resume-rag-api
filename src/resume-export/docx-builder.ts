import { Document, Paragraph, TextRun, Packer, convertInchesToTwip } from 'docx';
import type { ResumeDocument } from '../llm/claude.client.js';

// A lighter tint of the web app's --accent (#6D28D9) -- used only for the
// exported document's headings, not the site's own buttons/links, per the
// user's reference resume using a comparatively lighter heading color
// than our full-strength brand purple.
const ACCENT_COLOR = '7C3AED';
// Matches the user's own reference resume's style exactly: Calibri for
// the name/headings, Cambria for body text. Both are real font NAMES, not
// embedded files -- Word renders using whatever's installed on the
// viewer's machine, same mechanism the reference file itself uses (it has
// no embedded font binary either). Both ship with Office/Windows and are
// near-universally available, same as how Calibri alone worked before.
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
        new TextRun({ text: doc.name, bold: true, color: ACCENT_COLOR, size: 28, font: HEADING_FONT }),
      ],
    }),
  ];

  if (doc.title) {
    children.push(
      new Paragraph({
        spacing: { after: 40, ...LINE_SPACING },
        children: [new TextRun({ text: doc.title, size: 22, font: BODY_FONT })],
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
        spacing: { before: 160, after: 80, ...LINE_SPACING },
        children: [
          new TextRun({
            text: 'PROFESSIONAL SUMMARY',
            bold: true,
            color: ACCENT_COLOR,
            size: 26,
            font: HEADING_FONT,
          }),
        ],
      }),
    );
    children.push(
      new Paragraph({
        spacing: { after: 240, ...LINE_SPACING },
        children: [new TextRun({ text: doc.summary, size: 22, font: BODY_FONT })],
      }),
    );
  }

  for (const section of doc.sections) {
    children.push(
      new Paragraph({
        spacing: { before: 280, after: 120, ...LINE_SPACING },
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
      if (section.heading === 'Skills') {
        // One category per line ("Category: skill, skill, skill") rather
        // than a bullet per skill or one giant comma-separated line --
        // wraps naturally regardless of length, and groups read like a
        // normal resume Skills section. Unlabeled (no category assigned
        // yet) items just render their list with no leading label.
        if (item.bullets.length === 0) continue;
        children.push(
          new Paragraph({
            spacing: { after: 100, ...LINE_SPACING },
            indent: { left: convertInchesToTwip(0.15) },
            children: item.title
              ? [
                  new TextRun({ text: `${item.title}: `, bold: true, size: 22, font: BODY_FONT }),
                  new TextRun({ text: item.bullets.join(', '), size: 22, font: BODY_FONT }),
                ]
              : [new TextRun({ text: item.bullets.join(', '), size: 22, font: BODY_FONT })],
          }),
        );
        continue;
      }
      if (hasOwnItemTitle(item, section)) {
        // Dates get their own line rather than being appended after the
        // title -- a long job/degree title plus a date range on one line
        // wraps awkwardly, especially in the narrower page margins.
        children.push(
          new Paragraph({
            spacing: { before: 120, after: item.subtitle ? 0 : 60, ...LINE_SPACING },
            children: [new TextRun({ text: item.title, bold: true, size: 22, font: BODY_FONT })],
          }),
        );
        if (item.subtitle) {
          children.push(
            new Paragraph({
              spacing: { after: 60, ...LINE_SPACING },
              children: [new TextRun({ text: item.subtitle, color: '666666', size: 18, font: BODY_FONT })],
            }),
          );
        }
      }
      for (const bullet of item.bullets) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 60, ...LINE_SPACING },
            indent: { left: convertInchesToTwip(0.2) },
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
