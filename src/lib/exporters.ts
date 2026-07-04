import type { ManuscriptProject } from "./types";
import { downloadBlob } from "./storage";
import { sanitizeFileName, stripHtml } from "./defaultProject";

const mmToTwip = (value: number) => Math.round(value * 56.6929133858);

export async function exportProjectDocx(project: ManuscriptProject): Promise<void> {
  const docx = await import("docx");
  const children: InstanceType<typeof docx.Paragraph>[] = [];
  const bodyFont = project.pageSettings.fontFamily === "noto-sans-jp" ? "Noto Sans JP" : "Noto Serif JP";
  const uiFont = "Noto Sans JP";
  const lineSpacingTwips = Math.round(project.pageSettings.fontSizePt * 20 * project.pageSettings.lineHeight);
  const paragraphAfterTwips = mmToTwip(project.pageSettings.paragraphSpacingMm);

  project.chapters.forEach((chapter, chapterIndex) => {
    if (chapterIndex > 0) {
      children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
    }

    children.push(
      new docx.Paragraph({
        children: [
          new docx.TextRun({
            text: chapter.title,
            font: bodyFont,
            size: Math.round(project.pageSettings.fontSizePt * 2.6)
          })
        ],
        heading: docx.HeadingLevel.HEADING_1
      })
    );

    parseHtmlBlocks(chapter.content).forEach((block) => {
      if (block.kind === "pageBreak") {
        children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
        return;
      }

      children.push(
        new docx.Paragraph({
          children: [
            new docx.TextRun({
              text: block.text,
              font: bodyFont,
              size: Math.round(project.pageSettings.fontSizePt * 2)
            })
          ],
          heading: block.kind === "heading" ? docx.HeadingLevel.HEADING_2 : undefined,
          spacing: {
            after: paragraphAfterTwips,
            line: lineSpacingTwips,
            lineRule: docx.LineRuleType.AT_LEAST
          }
        })
      );
    });
  });

  const document = new docx.Document({
    creator: "Umbrella Parade",
    title: project.title,
    description: project.subtitle,
    features: {
      updateFields: true
    },
    sections: [
      {
        headers: {
          default: new docx.Header({
            children: [
              new docx.Paragraph({
                alignment: docx.AlignmentType.RIGHT,
                children: [
                  new docx.TextRun({
                    text: project.title,
                    font: uiFont,
                    size: 16,
                    color: "7A7168"
                  })
                ]
              })
            ]
          })
        },
        footers: {
          default: new docx.Footer({
            children: [
              new docx.Paragraph({
                alignment: docx.AlignmentType.CENTER,
                children: project.pageSettings.showPageNumber
                  ? [
                      new docx.TextRun({
                        children: [docx.PageNumber.CURRENT],
                        font: uiFont,
                        size: 16,
                        color: "7A7168"
                      })
                    ]
                  : [
                      new docx.TextRun({
                        text: project.author,
                        font: uiFont,
                        size: 16,
                        color: "7A7168"
                      })
                    ]
              })
            ]
          })
        },
        properties: {
          page: {
            size: {
              width: mmToTwip(project.pageSettings.pageWidthMm),
              height: mmToTwip(project.pageSettings.pageHeightMm)
            },
            margin: {
              top: mmToTwip(project.pageSettings.marginTopMm),
              bottom: mmToTwip(project.pageSettings.marginBottomMm),
              left: mmToTwip(project.pageSettings.marginLeftMm),
              right: mmToTwip(project.pageSettings.marginRightMm),
              header: mmToTwip(Math.max(4, project.pageSettings.marginTopMm / 2)),
              footer: mmToTwip(Math.max(4, project.pageSettings.marginBottomMm / 2))
            },
            pageNumbers: {
              start: 1
            }
          }
        },
        children
      }
    ]
  });

  const blob = await docx.Packer.toBlob(document);
  downloadBlob(blob, `${sanitizeFileName(project.title)}_Kindle.docx`);
}

function parseHtmlBlocks(html: string): Array<{ kind: "paragraph" | "heading" | "pageBreak"; text: string }> {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blocks: Array<{ kind: "paragraph" | "heading" | "pageBreak"; text: string }> = [];

  template.content.querySelectorAll("p,h1,h2,h3,li,blockquote,div[data-type='page-break'],figure[data-type='qr-card']").forEach((node) => {
    const element = node as HTMLElement;
    if (element.matches("div[data-type='page-break']")) {
      blocks.push({ kind: "pageBreak", text: "" });
      return;
    }

    if (element.matches("figure[data-type='qr-card']")) {
      const title = element.dataset.title ?? element.querySelector(".qr-card-title")?.textContent ?? "QRリンク";
      const url = element.dataset.url ?? element.querySelector(".qr-card-url")?.textContent ?? "";
      blocks.push({ kind: "paragraph", text: `${title}: ${url}` });
      return;
    }

    const text = stripHtml(element.outerHTML);
    if (!text) {
      return;
    }

    blocks.push({
      kind: element.matches("h1,h2,h3") ? "heading" : "paragraph",
      text
    });
  });

  if (blocks.length === 0) {
    blocks.push({ kind: "paragraph", text: stripHtml(html) });
  }

  return blocks;
}
