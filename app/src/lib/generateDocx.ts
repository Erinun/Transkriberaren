import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  Packer,
  LevelFormat,
  convertInchesToTwip,
} from "docx";

const PRIMARY_COLOR = "2563eb";

interface ParsedRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

/**
 * Parse inline markdown (bold, italic) into run descriptors.
 * Supports **bold**, *italic*, and ***bold+italic***.
 */
function parseInlineRuns(text: string): ParsedRun[] {
  const runs: ParsedRun[] = [];
  // Match ***bold+italic***, **bold**, *italic*, or plain text
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|([^*]+))/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      runs.push({ text: match[2], bold: true, italic: true });
    } else if (match[3]) {
      runs.push({ text: match[3], bold: true });
    } else if (match[4]) {
      runs.push({ text: match[4], italic: true });
    } else if (match[5]) {
      runs.push({ text: match[5] });
    }
  }
  return runs;
}

function makeTextRun(run: ParsedRun, defaultSize?: number): TextRun {
  return new TextRun({
    text: run.text,
    font: "Calibri",
    size: defaultSize ?? 22,
    bold: run.bold || undefined,
    italics: run.italic || undefined,
    color: run.color || undefined,
  });
}

/**
 * Convert a markdown string to a docx Document.
 */
export function markdownToDocx(markdown: string): Document {
  const lines = markdown.split("\n");
  const paragraphs: Paragraph[] = [];

  // Numbering config for bullet and numbered lists
  const numberingConfig = {
    config: [
      {
        reference: "bullet-list",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "\u2022",
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: {
                indent: {
                  left: convertInchesToTwip(0.25),
                  hanging: convertInchesToTwip(0.25),
                },
              },
            },
          },
        ],
      },
      {
        reference: "numbered-list",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: {
                indent: {
                  left: convertInchesToTwip(0.25),
                  hanging: convertInchesToTwip(0.25),
                },
              },
            },
          },
        ],
      },
    ],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Heading 1: # ...
    if (line.startsWith("# ")) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [
            new TextRun({
              text: line.slice(2),
              font: "Calibri",
              size: 32, // 16pt
              bold: true,
            }),
          ],
          spacing: { after: 200 },
        }),
      );
      continue;
    }

    // Heading 2: ## ...
    if (line.startsWith("## ")) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [
            new TextRun({
              text: line.slice(3),
              font: "Calibri",
              size: 28, // 14pt
              bold: true,
            }),
          ],
          spacing: { before: 240, after: 120 },
        }),
      );
      continue;
    }

    // Heading 3: ### ...
    if (line.startsWith("### ")) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [
            new TextRun({
              text: line.slice(4),
              font: "Calibri",
              size: 24, // 12pt
              bold: true,
            }),
          ],
          spacing: { before: 200, after: 100 },
        }),
      );
      continue;
    }

    // Horizontal rule: --- or more
    if (/^-{3,}$/.test(line.trim())) {
      paragraphs.push(
        new Paragraph({
          border: {
            bottom: {
              color: "CCCCCC",
              space: 1,
              style: BorderStyle.SINGLE,
              size: 6,
            },
          },
          spacing: { before: 120, after: 120 },
        }),
      );
      continue;
    }

    // Empty line → spacing
    if (line.trim() === "") {
      paragraphs.push(
        new Paragraph({
          spacing: { before: 60, after: 60 },
          children: [],
        }),
      );
      continue;
    }

    // Bold label pattern: **Label:** text (matches app's renderMarkdown)
    const boldLabelMatch = line.match(/^\*\*(.+?):\*\*\s*(.*)/);
    if (boldLabelMatch) {
      const label = boldLabelMatch[1] + ":";
      const rest = boldLabelMatch[2];
      const children: TextRun[] = [
        new TextRun({
          text: label,
          font: "Calibri",
          size: 22,
          bold: true,
          color: PRIMARY_COLOR,
        }),
      ];
      if (rest) {
        children.push(
          new TextRun({
            text: " " + rest,
            font: "Calibri",
            size: 22,
          }),
        );
      }
      paragraphs.push(
        new Paragraph({
          children,
          spacing: { before: 100, after: 40 },
        }),
      );
      continue;
    }

    // Bullet list: - ...
    if (line.match(/^[-*]\s+/)) {
      const content = line.replace(/^[-*]\s+/, "");
      const runs = parseInlineRuns(content).map((r) => makeTextRun(r));
      paragraphs.push(
        new Paragraph({
          numbering: { reference: "bullet-list", level: 0 },
          children: runs,
          spacing: { before: 40, after: 40 },
        }),
      );
      continue;
    }

    // Numbered list: 1. ...
    if (line.match(/^\d+\.\s+/)) {
      const content = line.replace(/^\d+\.\s+/, "");
      const runs = parseInlineRuns(content).map((r) => makeTextRun(r));
      paragraphs.push(
        new Paragraph({
          numbering: { reference: "numbered-list", level: 0 },
          children: runs,
          spacing: { before: 40, after: 40 },
        }),
      );
      continue;
    }

    // Full-line italic: *text*
    if (line.startsWith("*") && line.endsWith("*") && !line.startsWith("**")) {
      const text = line.slice(1, -1);
      // Handle trailing whitespace markers (e.g. "  " at end of line)
      const cleanText = text.replace(/\s{2,}$/, "");
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: cleanText,
              font: "Calibri",
              size: 20, // 10pt for footer-style
              italics: true,
              color: "666666",
            }),
          ],
          spacing: { before: 20, after: 20 },
        }),
      );
      continue;
    }

    // Regular paragraph with inline formatting
    const runs = parseInlineRuns(line).map((r) => makeTextRun(r));
    paragraphs.push(
      new Paragraph({
        children: runs,
        spacing: { before: 40, after: 40 },
      }),
    );
  }

  return new Document({
    numbering: numberingConfig,
    sections: [
      {
        children: paragraphs,
      },
    ],
  });
}

/**
 * Generate a docx file from markdown and return it as a base64-encoded string.
 */
export async function generateDocxBase64(markdown: string): Promise<string> {
  const doc = markdownToDocx(markdown);
  return await Packer.toBase64String(doc);
}
