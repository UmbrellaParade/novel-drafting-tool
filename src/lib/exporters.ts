import type { ManuscriptProject } from "./types";
import { downloadBlob } from "./storage";
import { sanitizeFileName, stripHtml } from "./defaultProject";
import type { PDFDocument, PDFFont, PDFImage, PDFPage, RGB } from "pdf-lib";

const mmToTwip = (value: number) => Math.round(value * 56.6929133858);
const mmToPt = (value: number) => (value * 72) / 25.4;

const FONT_URLS = {
  "noto-serif-jp": "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Serif/OTF/Japanese/NotoSerifCJKjp-Regular.otf",
  "noto-sans-jp": "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf"
} as const;

type PdfTextBlock = {
  kind: "text";
  text: string;
  level: 0 | 1 | 2 | 3;
};

type PdfImageBlock = {
  kind: "image";
  src: string;
  alt: string;
};

type PdfQrBlock = {
  kind: "qr";
  url: string;
  title: string;
  description: string;
  src: string;
  label: string;
};

type PdfBlock = PdfTextBlock | PdfImageBlock | PdfQrBlock | { kind: "pageBreak" };

type PdfRenderState = {
  pdfDoc: PDFDocument;
  font: PDFFont;
  uiFont: PDFFont;
  page: PDFPage;
  pageNumber: number;
  chapterTitle: string;
  project: ManuscriptProject;
  pageWidth: number;
  pageHeight: number;
  contentX: number;
  contentTop: number;
  contentBottom: number;
  contentWidth: number;
  y: number;
  colors: {
    paper: RGB;
    ink: RGB;
    muted: RGB;
    guide: RGB;
    brass: RGB;
    white: RGB;
  };
};

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

export async function exportProjectPdf(project: ManuscriptProject): Promise<void> {
  const [{ PDFDocument, rgb }, fontkitModule] = await Promise.all([import("pdf-lib"), import("@pdf-lib/fontkit")]);
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit("default" in fontkitModule ? fontkitModule.default : fontkitModule);

  const font = await loadPdfFont(pdfDoc, project.pageSettings.fontFamily);
  const pageWidth = mmToPt(project.pageSettings.pageWidthMm);
  const pageHeight = mmToPt(project.pageSettings.pageHeightMm);
  const contentX = mmToPt(project.pageSettings.marginLeftMm);
  const contentTop = pageHeight - mmToPt(project.pageSettings.marginTopMm);
  const contentBottom = mmToPt(project.pageSettings.marginBottomMm);
  const contentWidth = pageWidth - mmToPt(project.pageSettings.marginLeftMm + project.pageSettings.marginRightMm);
  const firstChapter = project.chapters[0] ?? { title: project.title, content: "" };
  const state: PdfRenderState = {
    pdfDoc,
    font,
    uiFont: font,
    page: pdfDoc.addPage([pageWidth, pageHeight]),
    pageNumber: 0,
    chapterTitle: firstChapter.title,
    project,
    pageWidth,
    pageHeight,
    contentX,
    contentTop,
    contentBottom,
    contentWidth,
    y: contentTop,
    colors: {
      paper: rgb(1, 0.992, 0.973),
      ink: rgb(0.122, 0.114, 0.102),
      muted: rgb(0.478, 0.443, 0.408),
      guide: rgb(0.227, 0.51, 0.471),
      brass: rgb(0.718, 0.518, 0.259),
      white: rgb(1, 1, 1)
    }
  };

  startPdfPage(state, firstChapter.title);

  for (const [chapterIndex, chapter] of project.chapters.entries()) {
    if (chapterIndex > 0) {
      startPdfPage(state, chapter.title);
    } else {
      state.chapterTitle = chapter.title;
    }

    drawTextBlock(state, chapter.title, 1);

    for (const block of parsePdfBlocks(chapter.content)) {
      if (block.kind === "pageBreak") {
        startPdfPage(state, chapter.title);
      } else if (block.kind === "image") {
        await drawImageBlock(state, block);
      } else if (block.kind === "qr") {
        await drawQrBlock(state, block);
      } else {
        drawTextBlock(state, block.text, block.level);
      }
    }
  }

  const bytes = await pdfDoc.save();
  const pdfBytes = new Uint8Array(bytes);
  downloadBlob(new Blob([pdfBytes.buffer], { type: "application/pdf" }), `${sanitizeFileName(project.title)}_book.pdf`);
}

async function loadPdfFont(pdfDoc: PDFDocument, fontFamily: ManuscriptProject["pageSettings"]["fontFamily"]): Promise<PDFFont> {
  let response = await fetch(FONT_URLS[fontFamily] ?? FONT_URLS["noto-serif-jp"]);
  if (!response.ok && fontFamily !== "noto-sans-jp") {
    response = await fetch(FONT_URLS["noto-sans-jp"]);
  }

  if (!response.ok) {
    throw new Error("PDF用フォントを取得できませんでした。オンライン接続を確認してください。");
  }

  return pdfDoc.embedFont(await response.arrayBuffer(), { subset: true });
}

function startPdfPage(state: PdfRenderState, chapterTitle: string): void {
  if (state.pageNumber === 0) {
    state.page = state.pdfDoc.getPages()[0];
  } else {
    state.page = state.pdfDoc.addPage([state.pageWidth, state.pageHeight]);
  }

  state.pageNumber += 1;
  state.chapterTitle = chapterTitle;
  state.y = state.contentTop;
  drawPdfPageChrome(state);
}

function drawPdfPageChrome(state: PdfRenderState): void {
  const { page, project, colors } = state;
  const settings = project.pageSettings;
  const marginTop = mmToPt(settings.marginTopMm);
  const marginBottom = mmToPt(settings.marginBottomMm);
  const marginLeft = mmToPt(settings.marginLeftMm);
  const marginRight = mmToPt(settings.marginRightMm);
  const smallSize = 7;

  page.drawRectangle({
    x: 0,
    y: 0,
    width: state.pageWidth,
    height: state.pageHeight,
    color: colors.paper
  });

  if (settings.showBleedGuide) {
    const inset = mmToPt(3);
    page.drawRectangle({
      x: inset,
      y: inset,
      width: state.pageWidth - inset * 2,
      height: state.pageHeight - inset * 2,
      borderColor: colors.brass,
      borderWidth: 0.4
    });
  }

  if (settings.showSafeArea) {
    page.drawRectangle({
      x: marginLeft,
      y: marginBottom,
      width: state.pageWidth - marginLeft - marginRight,
      height: state.pageHeight - marginTop - marginBottom,
      borderColor: colors.guide,
      borderWidth: 0.35
    });
  }

  const headerY = state.pageHeight - Math.max(mmToPt(2), marginTop / 2);
  const footerY = Math.max(mmToPt(2), marginBottom / 2);
  const halfWidth = Math.max(10, state.contentWidth / 2 - mmToPt(2));
  const title = truncateToWidth(project.title, state.uiFont, smallSize, halfWidth);
  const chapter = truncateToWidth(state.chapterTitle, state.uiFont, smallSize, halfWidth);
  const chapterWidth = state.uiFont.widthOfTextAtSize(chapter, smallSize);
  const author = truncateToWidth(project.author, state.uiFont, smallSize, halfWidth);

  page.drawText(title, { x: marginLeft, y: headerY, font: state.uiFont, size: smallSize, color: colors.muted });
  page.drawText(chapter, {
    x: state.pageWidth - marginRight - chapterWidth,
    y: headerY,
    font: state.uiFont,
    size: smallSize,
    color: colors.muted
  });
  page.drawText(author, { x: marginLeft, y: footerY, font: state.uiFont, size: smallSize, color: colors.muted });

  if (settings.showPageNumber) {
    const pageNumber = String(state.pageNumber);
    const pageNumberWidth = state.uiFont.widthOfTextAtSize(pageNumber, smallSize);
    page.drawText(pageNumber, {
      x: state.pageWidth - marginRight - pageNumberWidth,
      y: footerY,
      font: state.uiFont,
      size: smallSize,
      color: colors.muted
    });
  }
}

function drawTextBlock(state: PdfRenderState, text: string, level: 0 | 1 | 2 | 3): void {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return;
  }

  const baseSize = projectFontSize(state);
  const size = level === 1 ? baseSize * 1.55 : level === 2 ? baseSize * 1.32 : level === 3 ? baseSize * 1.16 : baseSize;
  const lineHeight = size * (level === 0 ? state.project.pageSettings.lineHeight : 1.35);
  const spaceAfter = mmToPt(level === 0 ? state.project.pageSettings.paragraphSpacingMm : state.project.pageSettings.paragraphSpacingMm * 2);
  const lines = wrapText(normalized, state.font, size, state.contentWidth);

  for (const line of lines) {
    ensureVerticalSpace(state, lineHeight);
    state.page.drawText(line, {
      x: state.contentX,
      y: state.y - size,
      font: state.font,
      size,
      color: state.colors.ink
    });
    state.y -= lineHeight;
  }

  state.y -= spaceAfter;
}

async function drawImageBlock(state: PdfRenderState, block: PdfImageBlock): Promise<void> {
  if (!block.src) {
    return;
  }

  const image = await embedImage(state.pdfDoc, block.src);
  const maxWidth = state.contentWidth;
  const maxHeight = Math.min(mmToPt(state.project.pageSettings.imageMaxHeightMm), state.contentTop - state.contentBottom);
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  const width = image.width * scale;
  const height = image.height * scale;

  ensureVerticalSpace(state, height);
  state.page.drawImage(image, {
    x: state.contentX + (state.contentWidth - width) / 2,
    y: state.y - height,
    width,
    height
  });
  state.y -= height + mmToPt(state.project.pageSettings.paragraphSpacingMm + 2);
}

async function drawQrBlock(state: PdfRenderState, block: PdfQrBlock): Promise<void> {
  const QRCode = await import("qrcode");
  const src =
    block.src ||
    (await QRCode.toDataURL(block.url, {
      margin: 1,
      width: 420,
      color: { dark: "#24211d", light: "#ffffff" }
    }));
  const image = await embedImage(state.pdfDoc, src);
  const cardWidth = Math.min(state.contentWidth, mmToPt(74));
  const cardPadding = mmToPt(4);
  const qrSize = mmToPt(23);
  const labelSize = 7;
  const bodyTextSize = 8;
  const urlSize = 6;
  const captionX = state.contentX + (state.contentWidth - cardWidth) / 2 + cardPadding + qrSize + mmToPt(4);
  const captionWidth = cardWidth - cardPadding * 2 - qrSize - mmToPt(4);
  const titleLines = wrapText(block.title, state.uiFont, bodyTextSize, captionWidth).slice(0, 2);
  const descriptionLines = wrapText(block.description, state.uiFont, urlSize, captionWidth).slice(0, 2);
  const urlLines = wrapText(block.url, state.uiFont, urlSize, captionWidth).slice(0, 2);
  const textHeight = (titleLines.length * bodyTextSize * 1.35) + ((descriptionLines.length + urlLines.length) * urlSize * 1.35);
  const bodyHeight = Math.max(qrSize, textHeight);
  const cardHeight = cardPadding * 2 + labelSize * 1.35 + mmToPt(2) + bodyHeight;

  ensureVerticalSpace(state, cardHeight);
  const cardX = state.contentX + (state.contentWidth - cardWidth) / 2;
  const cardY = state.y - cardHeight;

  state.page.drawRectangle({
    x: cardX,
    y: cardY,
    width: cardWidth,
    height: cardHeight,
    color: state.colors.white,
    borderColor: state.colors.ink,
    borderWidth: 0.8
  });

  const label = truncateToWidth(block.label, state.uiFont, labelSize, cardWidth - cardPadding * 2);
  const labelWidth = state.uiFont.widthOfTextAtSize(label, labelSize);
  state.page.drawText(label, {
    x: cardX + (cardWidth - labelWidth) / 2,
    y: cardY + cardHeight - cardPadding - labelSize,
    font: state.uiFont,
    size: labelSize,
    color: state.colors.muted
  });

  const bodyTop = cardY + cardHeight - cardPadding - labelSize * 1.35 - mmToPt(2);
  state.page.drawImage(image, {
    x: cardX + cardPadding,
    y: bodyTop - qrSize,
    width: qrSize,
    height: qrSize
  });

  let textY = bodyTop - bodyTextSize;
  for (const line of titleLines) {
    state.page.drawText(line, { x: captionX, y: textY, font: state.uiFont, size: bodyTextSize, color: state.colors.ink });
    textY -= bodyTextSize * 1.35;
  }
  for (const line of descriptionLines) {
    state.page.drawText(line, { x: captionX, y: textY, font: state.uiFont, size: urlSize, color: state.colors.muted });
    textY -= urlSize * 1.35;
  }
  for (const line of urlLines) {
    state.page.drawText(line, { x: captionX, y: textY, font: state.uiFont, size: urlSize, color: state.colors.muted });
    textY -= urlSize * 1.35;
  }

  state.y -= cardHeight + mmToPt(state.project.pageSettings.paragraphSpacingMm + 1);
}

function ensureVerticalSpace(state: PdfRenderState, neededHeight: number): void {
  if (state.y - neededHeight >= state.contentBottom) {
    return;
  }

  startPdfPage(state, state.chapterTitle);
}

function projectFontSize(state: PdfRenderState): number {
  return state.project.pageSettings.fontSizePt;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";

  for (const char of Array.from(text)) {
    if (char === "\n") {
      if (line) {
        lines.push(line);
      }
      line = "";
      continue;
    }

    const next = line + char;
    if (line && font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(line);
      line = char.trimStart();
    } else {
      line = next;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines.length ? lines : [text];
}

function truncateToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) {
    return text;
  }

  let value = "";
  for (const char of Array.from(text)) {
    const next = `${value}${char}`;
    if (font.widthOfTextAtSize(`${next}...`, size) > maxWidth) {
      return `${value}...`;
    }
    value = next;
  }

  return value;
}

async function embedImage(pdfDoc: PDFDocument, src: string): Promise<PDFImage> {
  const { bytes, mimeType } = await loadImageBytes(src);
  if (mimeType.includes("png") || isPng(bytes)) {
    return pdfDoc.embedPng(bytes);
  }

  if (mimeType.includes("jpeg") || mimeType.includes("jpg") || isJpeg(bytes)) {
    return pdfDoc.embedJpg(bytes);
  }

  throw new Error("PDFに入れられる画像はPNGまたはJPEGです。");
}

async function loadImageBytes(src: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (src.startsWith("data:")) {
    const [header, base64] = src.split(",", 2);
    const mimeType = header.match(/^data:([^;]+)/)?.[1] ?? "";
    const binary = atob(base64 ?? "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { bytes, mimeType };
  }

  const response = await fetch(src);
  if (!response.ok) {
    throw new Error("PDF用画像を取得できませんでした。");
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") ?? ""
  };
}

function isPng(bytes: Uint8Array): boolean {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

function parsePdfBlocks(html: string): PdfBlock[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blocks: PdfBlock[] = [];

  template.content.querySelectorAll("p,h1,h2,h3,li,blockquote,div[data-type='page-break'],figure[data-type='qr-card'],img").forEach((node) => {
    const element = node as HTMLElement;
    if (element.matches("div[data-type='page-break']")) {
      blocks.push({ kind: "pageBreak" });
      return;
    }

    if (element.matches("figure[data-type='qr-card']")) {
      blocks.push({
        kind: "qr",
        url: element.dataset.url ?? "",
        title: element.dataset.title ?? element.querySelector(".qr-card-title")?.textContent ?? "QRリンク",
        description: element.dataset.description ?? element.querySelector(".qr-card-description")?.textContent ?? "",
        src: element.dataset.src ?? element.querySelector("img")?.getAttribute("src") ?? "",
        label: element.dataset.label ?? "Umbrella Parade 記録室"
      });
      return;
    }

    if (element.matches("img")) {
      if (element.closest("figure[data-type='qr-card']")) {
        return;
      }
      blocks.push({
        kind: "image",
        src: element.getAttribute("src") ?? "",
        alt: element.getAttribute("alt") ?? element.getAttribute("title") ?? ""
      });
      return;
    }

    const text = stripHtml(element.outerHTML);
    if (!text) {
      return;
    }

    blocks.push({
      kind: "text",
      text,
      level: element.matches("h1") ? 1 : element.matches("h2") ? 2 : element.matches("h3") ? 3 : 0
    });
  });

  if (blocks.length === 0) {
    const text = stripHtml(html);
    if (text) {
      blocks.push({ kind: "text", text, level: 0 });
    }
  }

  return blocks;
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
