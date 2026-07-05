import type { ManuscriptProject, QrCardTemplateId, TocStyleId } from "./types";
import { downloadBlob } from "./storage";
import { sanitizeFileName, stripHtml } from "./defaultProject";
import type { PDFDocument, PDFFont, PDFImage, PDFPage, RGB } from "pdf-lib";

const mmToTwip = (value: number) => Math.round(value * 56.6929133858);
const mmToPt = (value: number) => (value * 72) / 25.4;

const FONT_URLS = {
  "noto-serif-jp": "https://raw.githubusercontent.com/google/fonts/main/ofl/bizudpmincho/BIZUDPMincho-Regular.ttf",
  "noto-sans-jp": "https://raw.githubusercontent.com/google/fonts/main/ofl/bizudpgothic/BIZUDPGothic-Regular.ttf"
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
  width?: number;
  height?: number;
};

type PdfQrBlock = {
  kind: "qr";
  url: string;
  title: string;
  description: string;
  src: string;
  label: string;
  template: QrCardTemplateId;
  width?: number;
  height?: number;
};

type TocExportEntry = {
  title: string;
  page: number | null;
};

type PdfTocBlock = {
  kind: "toc";
  title: string;
  subtitle: string;
  style: TocStyleId;
  fontSizePt?: number;
  titleGapPt?: number;
  items: TocExportEntry[];
};

type PdfBlock = PdfTextBlock | PdfImageBlock | PdfQrBlock | PdfTocBlock | { kind: "pageBreak" };

type EpubAsset = {
  id: string;
  href: string;
  mediaType: string;
  data: Uint8Array;
};

type EpubAssetState = {
  nextIndex: number;
  assets: EpubAsset[];
  sourceMap: Map<string, EpubAsset>;
};

type EpubNavItem = {
  title: string;
  href: string;
};

type EpubChapter = {
  id: string;
  href: string;
  title: string;
  body: string;
  navItems: EpubNavItem[];
};

type ZipEntry = {
  path: string;
  data: Uint8Array;
};

type PdfRenderState = {
  pdfDoc: PDFDocument;
  font: PDFFont;
  uiFont: PDFFont;
  page: PDFPage;
  pageNumber: number;
  chapterTitle: string;
  pageTitles: string[];
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
    white: RGB;
    rain: RGB;
    rainPaper: RGB;
    antiqueInk: RGB;
    antiquePaper: RGB;
    midnightPaper: RGB;
    midnightInk: RGB;
    gold: RGB;
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

export async function exportProjectEpub(project: ManuscriptProject): Promise<void> {
  const assetState: EpubAssetState = { nextIndex: 1, assets: [], sourceMap: new Map() };
  const chapters: EpubChapter[] = [];

  for (const [chapterIndex, chapter] of project.chapters.entries()) {
    chapters.push(await buildEpubChapter(chapter.title, chapter.content, chapterIndex + 1, assetState));
  }

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const files: ZipEntry[] = [
    { path: "mimetype", data: encodeUtf8("application/epub+zip") },
    { path: "META-INF/container.xml", data: encodeUtf8(epubContainerXml()) },
    { path: "OEBPS/package.opf", data: encodeUtf8(epubPackageOpf(project, chapters, assetState.assets, now)) },
    { path: "OEBPS/nav.xhtml", data: encodeUtf8(epubNavXhtml(project, chapters.flatMap((chapter) => chapter.navItems))) },
    { path: "OEBPS/styles.css", data: encodeUtf8(epubCss(project)) },
    ...chapters.map((chapter) => ({
      path: `OEBPS/${chapter.href}`,
      data: encodeUtf8(epubChapterXhtml(project, chapter))
    })),
    ...assetState.assets.map((asset) => ({
      path: `OEBPS/${asset.href}`,
      data: asset.data
    }))
  ];

  const zipBytes = createStoredZip(files);
  const epubBuffer = new ArrayBuffer(zipBytes.byteLength);
  new Uint8Array(epubBuffer).set(zipBytes);
  downloadBlob(new Blob([epubBuffer], { type: "application/epub+zip" }), `${sanitizeFileName(project.title)}.epub`);
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
  const state: PdfRenderState = {
    pdfDoc,
    font,
    uiFont: font,
    page: pdfDoc.addPage([pageWidth, pageHeight]),
    pageNumber: 0,
    chapterTitle: "",
    pageTitles: [],
    project,
    pageWidth,
    pageHeight,
    contentX,
    contentTop,
    contentBottom,
    contentWidth,
    y: contentTop,
    colors: {
      paper: rgb(1, 1, 1),
      ink: rgb(0.122, 0.114, 0.102),
      muted: rgb(0.478, 0.443, 0.408),
      white: rgb(1, 1, 1),
      rain: rgb(0.184, 0.443, 0.416),
      rainPaper: rgb(0.925, 0.973, 0.953),
      antiqueInk: rgb(0.357, 0.259, 0.176),
      antiquePaper: rgb(1, 0.973, 0.91),
      midnightPaper: rgb(0.078, 0.11, 0.176),
      midnightInk: rgb(0.973, 0.945, 0.875),
      gold: rgb(0.776, 0.612, 0.31)
    }
  };

  startPdfPage(state, "");

  for (const [chapterIndex, chapter] of project.chapters.entries()) {
    if (chapterIndex > 0) {
      startPdfPage(state, "");
    }

    for (const block of parsePdfBlocks(chapter.content)) {
      if (block.kind === "pageBreak") {
        startPdfPage(state, state.chapterTitle);
      } else if (block.kind === "image") {
        await drawImageBlock(state, block);
      } else if (block.kind === "qr") {
        await drawQrBlock(state, block);
      } else if (block.kind === "toc") {
        drawTocBlock(state, block);
      } else {
        if (block.level === 1) {
          state.chapterTitle = normalizePdfText(block.text) || state.chapterTitle;
        }
        drawTextBlock(state, block.text, block.level);
        if (block.level === 1) {
          setPdfCurrentPageTitle(state, state.chapterTitle);
        }
      }
    }
  }

  drawPdfPageChromeOnAllPages(state);
  const exportedPageCount = pdfDoc.getPageCount();
  if (isShimaumaPreset(project.pageSettings.preset) && exportedPageCount % 4 !== 0) {
    const missingPages = 4 - (exportedPageCount % 4);
    throw new Error(
      `しまうま出稿用PDFは4ページ単位にする必要があります。現在のPDFは${exportedPageCount}ページです。あと${missingPages}ページ分の白紙や奥付などを追加してから書き出してください。`
    );
  }

  const bytes = await pdfDoc.save();
  const pdfBytes = new Uint8Array(bytes);
  downloadBlob(new Blob([pdfBytes.buffer], { type: "application/pdf" }), `${sanitizeFileName(project.title)}_book.pdf`);
}

function isShimaumaPreset(preset: ManuscriptProject["pageSettings"]["preset"]): boolean {
  return preset === "shimauma-a6" || preset === "shimauma-a5";
}

async function buildEpubChapter(title: string, html: string, chapterNumber: number, assetState: EpubAssetState): Promise<EpubChapter> {
  const href = `chapter-${chapterNumber}.xhtml`;
  const template = document.createElement("template");
  template.innerHTML = html.trim() || "<p></p>";

  template.content.querySelectorAll("div[data-type='page-break']").forEach((pageBreak) => {
    const hr = document.createElement("hr");
    hr.className = "page-break";
    pageBreak.replaceWith(hr);
  });

  template.content.querySelectorAll("[contenteditable]").forEach((element) => {
    element.removeAttribute("contenteditable");
  });

  const images = [...template.content.querySelectorAll<HTMLImageElement>("img")];
  for (const image of images) {
    const src = image.getAttribute("src");
    if (!src) {
      continue;
    }

    const asset = await collectEpubImageAsset(src, assetState);
    if (asset) {
      image.setAttribute("src", asset.href);
      image.removeAttribute("data-src");
    }
  }

  template.content.querySelectorAll<HTMLElement>("figure[data-type='qr-card']").forEach((figure) => {
    figure.removeAttribute("data-src");
  });

  const navItems: EpubNavItem[] = [];
  const headings = [...template.content.querySelectorAll<HTMLElement>("h1")].filter((heading) => !heading.closest("[data-type='table-of-contents']"));
  if (headings.length === 0) {
    const heading = document.createElement("h1");
    heading.textContent = title;
    template.content.prepend(heading);
    headings.push(heading);
  }

  headings.forEach((heading, headingIndex) => {
    const id = heading.id || `chapter-${chapterNumber}-heading-${headingIndex + 1}`;
    heading.id = id;
    navItems.push({
      title: heading.textContent?.trim() || title,
      href: `${href}#${id}`
    });
  });

  const serializer = new XMLSerializer();
  const body = [...template.content.childNodes].map((node) => serializer.serializeToString(node)).join("\n");

  return {
    id: `chapter-${chapterNumber}`,
    href,
    title,
    body,
    navItems
  };
}

async function collectEpubImageAsset(src: string, state: EpubAssetState): Promise<EpubAsset | null> {
  const existing = state.sourceMap.get(src);
  if (existing) {
    return existing;
  }

  try {
    const { bytes, mimeType } = await loadImageBytes(src);
    const normalizedMime = normalizeImageMimeType(mimeType);
    const extension = imageExtensionForMimeType(normalizedMime);
    const asset: EpubAsset = {
      id: `image-${state.nextIndex}`,
      href: `images/image-${state.nextIndex}.${extension}`,
      mediaType: normalizedMime,
      data: bytes
    };
    state.nextIndex += 1;
    state.assets.push(asset);
    state.sourceMap.set(src, asset);
    return asset;
  } catch {
    return null;
  }
}

function epubContainerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function epubPackageOpf(project: ManuscriptProject, chapters: EpubChapter[], assets: EpubAsset[], modifiedAt: string): string {
  const title = escapeXml(project.title || "Untitled");
  const creator = escapeXml(project.author || "Umbrella Parade");
  const description = project.subtitle ? `<dc:description>${escapeXml(project.subtitle)}</dc:description>` : "";
  const manifestChapters = chapters
    .map((chapter) => `<item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml"/>`)
    .join("\n    ");
  const manifestAssets = assets
    .map((asset) => `<item id="${asset.id}" href="${asset.href}" media-type="${asset.mediaType}"/>`)
    .join("\n    ");
  const spine = chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(project.id)}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>ja</dc:language>
    <dc:creator>${creator}</dc:creator>
    ${description}
    <meta property="dcterms:modified">${modifiedAt}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="styles.css" media-type="text/css"/>
    ${manifestChapters}
    ${manifestAssets}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;
}

function epubNavXhtml(project: ManuscriptProject, navItems: EpubNavItem[]): string {
  const items = navItems.length
    ? navItems.map((item) => `<li><a href="${escapeXml(item.href)}">${escapeXml(item.title)}</a></li>`).join("\n        ")
    : `<li><a href="chapter-1.xhtml">${escapeXml(project.title)}</a></li>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
  <head>
    <title>${escapeXml(project.title)} 目次</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目次</h1>
      <ol>
        ${items}
      </ol>
    </nav>
  </body>
</html>`;
}

function epubChapterXhtml(project: ManuscriptProject, chapter: EpubChapter): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
  <head>
    <title>${escapeXml(chapter.title || project.title)}</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
  </head>
  <body>
    <section epub:type="chapter">
${chapter.body}
    </section>
  </body>
</html>`;
}

function epubCss(project: ManuscriptProject): string {
  const bodyFont = project.pageSettings.fontFamily === "noto-sans-jp" ? "sans-serif" : "serif";

  return `body {
  color: #24211d;
  font-family: ${bodyFont};
  font-size: ${project.pageSettings.fontSizePt}pt;
  line-height: ${project.pageSettings.lineHeight};
  line-break: strict;
  word-break: normal;
  word-break: auto-phrase;
  overflow-wrap: normal;
  hyphens: manual;
}

p {
  margin: 0 0 ${project.pageSettings.paragraphSpacingMm}mm;
}

h1, h2, h3 {
  line-height: 1.35;
  margin: 1.4em 0 0.8em;
}

ruby {
  ruby-position: over;
}

rt {
  font-size: ${project.pageSettings.rubySizePt}pt;
}

img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 1em auto;
}

.page-break {
  break-after: page;
  page-break-after: always;
  border: 0;
  height: 0;
}

.page-break-before,
[data-page-break-before="true"] {
  break-before: page;
  page-break-before: always;
}

.manuscript-toc {
  display: block;
  position: relative;
  margin: 1.4em auto;
  padding: 1.4em;
  border: 1.4px solid #111111;
  background: #ffffff;
  color: #111111;
}

.toc-title {
  margin: 0;
  text-align: center;
  font-size: 1.45em;
  font-weight: bold;
}

.toc-title::after {
  content: "";
  display: block;
  width: 5em;
  margin: 0.7em auto 0;
  border-top: 1.2px solid currentColor;
}

.toc-subtitle {
  display: none;
  margin: 0.4em 0 1.2em;
  text-align: center;
  color: #6b6258;
  font-size: 0.9em;
}

.toc-subtitle-empty {
  display: none;
}

.toc-list {
  list-style: none;
  margin: var(--toc-title-gap, 1.2em) 0 0;
  padding: 0;
}

.toc-entry {
  display: table;
  width: 100%;
  margin: 0.35em 0;
}

.toc-entry-title,
.toc-entry-leader,
.toc-entry-page {
  display: table-cell;
  vertical-align: baseline;
}

.toc-entry-title {
  width: auto;
}

.toc-entry-leader {
  width: 100%;
  border-bottom: 1px dotted currentColor;
  opacity: 0.7;
}

.toc-entry-page {
  min-width: 2.5em;
  color: currentColor;
  text-align: right;
}

.manuscript-toc-classic {
  border: 1.4px solid #111111;
  box-shadow: inset 0 0 0 4px #ffffff, inset 0 0 0 5px #111111;
}

.manuscript-toc-rain {
  border: 1.4px solid #111111;
  background:
    radial-gradient(circle, rgba(0, 0, 0, 0.18) 0 1px, transparent 1.4px) 6px 6px / 18px 18px,
    #ffffff;
}

.manuscript-toc-antique {
  border: 3px double #111111;
  background:
    linear-gradient(#111111 0 0) left 10px top 10px / 40px 1px no-repeat,
    linear-gradient(#111111 0 0) left 10px top 10px / 1px 40px no-repeat,
    linear-gradient(#111111 0 0) right 10px top 10px / 40px 1px no-repeat,
    linear-gradient(#111111 0 0) right 10px top 10px / 1px 40px no-repeat,
    linear-gradient(#111111 0 0) left 10px bottom 10px / 40px 1px no-repeat,
    linear-gradient(#111111 0 0) left 10px bottom 10px / 1px 40px no-repeat,
    linear-gradient(#111111 0 0) right 10px bottom 10px / 40px 1px no-repeat,
    linear-gradient(#111111 0 0) right 10px bottom 10px / 1px 40px no-repeat,
    #ffffff;
}

.manuscript-toc-midnight {
  border: 1.4px solid #111111;
  background:
    radial-gradient(ellipse at 50% -24px, transparent 0 54px, rgba(0, 0, 0, 0.2) 55px, transparent 56px) top center / 100% 72px no-repeat,
    linear-gradient(#111111 0 0) left 0 top 30px / 100% 1px no-repeat,
    #ffffff;
}

.qr-card {
  display: block;
  width: min(100%, 74mm);
  max-width: 100%;
  margin: 1.2em auto;
  padding: 4mm;
  border: 1px solid #37312c;
}

.qr-card-body {
  display: table;
  width: 100%;
}

.qr-card-image {
  display: table-cell;
  width: 23mm;
  margin: 0;
}

.qr-card-caption {
  display: table-cell;
  padding-left: 4mm;
  vertical-align: middle;
}

.qr-card-title,
.qr-card-description {
  display: block;
}

.qr-card-url {
  display: none;
}`;
}

function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  return normalized || "image/png";
}

function imageExtensionForMimeType(mimeType: string): string {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
    return "jpg";
  }
  if (mimeType.includes("gif")) {
    return "gif";
  }
  if (mimeType.includes("svg")) {
    return "svg";
  }
  if (mimeType.includes("webp")) {
    return "webp";
  }
  return "png";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function createStoredZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const dateParts = zipDateParts(new Date());
  let offset = 0;

  entries.forEach((entry) => {
    const name = encodeUtf8(entry.path);
    const data = entry.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dateParts.time, true);
    localView.setUint16(12, dateParts.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dateParts.time, true);
    centralView.setUint16(14, dateParts.date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  });

  const centralStart = offset;
  const centralDirectory = concatUint8Arrays(centralParts);
  offset += centralDirectory.length;

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, centralStart, true);
  endView.setUint16(20, 0, true);

  return concatUint8Arrays([...localParts, centralDirectory, end]);
}

function zipDateParts(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = new Uint32Array(
  Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  })
);

async function loadPdfFont(pdfDoc: PDFDocument, fontFamily: ManuscriptProject["pageSettings"]["fontFamily"]): Promise<PDFFont> {
  let response = await fetch(FONT_URLS[fontFamily] ?? FONT_URLS["noto-serif-jp"]);
  if (!response.ok && fontFamily !== "noto-sans-jp") {
    response = await fetch(FONT_URLS["noto-sans-jp"]);
  }

  if (!response.ok) {
    throw new Error("PDF用フォントを取得できませんでした。オンライン接続を確認してください。");
  }

  return pdfDoc.embedFont(await response.arrayBuffer(), { subset: false });
}

function startPdfPage(state: PdfRenderState, chapterTitle: string): void {
  if (state.pageNumber === 0) {
    state.page = state.pdfDoc.getPages()[0];
  } else {
    state.page = state.pdfDoc.addPage([state.pageWidth, state.pageHeight]);
  }

  state.pageNumber += 1;
  state.chapterTitle = chapterTitle;
  state.pageTitles[state.pageNumber - 1] = chapterTitle;
  state.y = state.contentTop;
  drawPdfPageBackground(state);
}

function drawPdfPageBackground(state: PdfRenderState): void {
  state.page.drawRectangle({
    x: 0,
    y: 0,
    width: state.pageWidth,
    height: state.pageHeight,
    color: state.colors.paper
  });
}

function setPdfCurrentPageTitle(state: PdfRenderState, chapterTitle: string): void {
  state.pageTitles[state.pageNumber - 1] = chapterTitle;
}

function drawPdfPageChromeOnAllPages(state: PdfRenderState): void {
  state.pdfDoc.getPages().forEach((page, index) => {
    drawPdfPageChrome(state, page, state.pageTitles[index] || "", index + 1);
  });
}

function drawPdfPageChrome(state: PdfRenderState, page: PDFPage, chapterTitle: string, pageNumber: number): void {
  const { project, colors } = state;
  const settings = project.pageSettings;
  const marginTop = mmToPt(settings.marginTopMm);
  const marginBottom = mmToPt(settings.marginBottomMm);
  const marginRight = mmToPt(settings.marginRightMm);
  const smallSize = 7;

  const headerY = state.pageHeight - Math.max(mmToPt(2), marginTop / 2);
  const footerY = Math.max(mmToPt(2), marginBottom / 2);
  const chapter = truncateToWidth(chapterTitle, state.uiFont, smallSize, state.contentWidth);
  if (chapter) {
    const chapterWidth = state.uiFont.widthOfTextAtSize(chapter, smallSize);
    page.drawText(chapter, {
      x: state.pageWidth - marginRight - chapterWidth,
      y: headerY,
      font: state.uiFont,
      size: smallSize,
      color: colors.muted
    });
  }

  if (settings.showPageNumber) {
    const pageNumberText = String(pageNumber);
    const pageNumberWidth = state.uiFont.widthOfTextAtSize(pageNumberText, smallSize);
    page.drawText(pageNumberText, {
      x: state.pageWidth - marginRight - pageNumberWidth,
      y: footerY,
      font: state.uiFont,
      size: smallSize,
      color: colors.muted
    });
  }
}

function drawTextBlock(state: PdfRenderState, text: string, level: 0 | 1 | 2 | 3): void {
  const normalized = normalizePdfText(text);
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

function drawTocBlock(state: PdfRenderState, block: PdfTocBlock): void {
  const theme = tocPdfTheme(state, block.style);
  const baseSize = block.fontSizePt && Number.isFinite(block.fontSizePt) && block.fontSizePt > 0 ? block.fontSizePt : projectFontSize(state);
  const titleSize = baseSize * 1.55;
  const entrySize = baseSize;
  const title = normalizePdfText(block.title) || "目次";
  const titleGap = typeof block.titleGapPt === "number" && Number.isFinite(block.titleGapPt) && block.titleGapPt >= 0 ? block.titleGapPt : baseSize * 2;
  const topPadding = mmToPt(4);
  const bottomPadding = mmToPt(4);
  const entryLineHeight = entrySize * 1.65;

  ensureVerticalSpace(state, topPadding + titleSize * 2.2);
  state.page.drawLine({
    start: { x: state.contentX, y: state.y },
    end: { x: state.contentX + state.contentWidth, y: state.y },
    thickness: theme.borderWidth,
    color: theme.border
  });
  state.y -= topPadding;

  const titleWidth = state.uiFont.widthOfTextAtSize(title, titleSize);
  state.page.drawText(title, {
    x: state.contentX + (state.contentWidth - titleWidth) / 2,
    y: state.y - titleSize,
    font: state.uiFont,
    size: titleSize,
    color: theme.ink
  });
  state.y -= titleSize + titleGap;

  for (const item of block.items) {
    const itemTitle = normalizePdfText(item.title);
    if (!itemTitle) {
      continue;
    }

    const pageText = item.page === null ? "..." : String(item.page);
    const pageWidth = state.uiFont.widthOfTextAtSize(pageText, entrySize);
    const titleWidthLimit = Math.max(mmToPt(24), state.contentWidth - pageWidth - mmToPt(10));
    const titleLines = wrapText(itemTitle, state.font, entrySize, titleWidthLimit);

    titleLines.forEach((line, lineIndex) => {
      ensureVerticalSpace(state, entryLineHeight);
      state.page.drawText(line, {
        x: state.contentX,
        y: state.y - entrySize,
        font: state.font,
        size: entrySize,
        color: theme.ink
      });

      if (lineIndex === 0) {
        const lineWidth = state.font.widthOfTextAtSize(line, entrySize);
        const dotsX = state.contentX + Math.min(titleWidthLimit, lineWidth) + mmToPt(2);
        const pageX = state.contentX + state.contentWidth - pageWidth;
        const dotsWidth = Math.max(0, pageX - dotsX - mmToPt(2));
        const dots = ".".repeat(Math.floor(dotsWidth / Math.max(1, state.uiFont.widthOfTextAtSize(".", entrySize))));
        if (dots) {
          state.page.drawText(dots, {
            x: dotsX,
            y: state.y - entrySize,
            font: state.uiFont,
            size: entrySize,
            color: theme.muted
          });
        }
        state.page.drawText(pageText, {
          x: pageX,
          y: state.y - entrySize,
          font: state.uiFont,
          size: entrySize,
          color: theme.accent
        });
      }

      state.y -= entryLineHeight;
    });
  }

  ensureVerticalSpace(state, bottomPadding + mmToPt(1));
  state.y -= bottomPadding;
  state.page.drawLine({
    start: { x: state.contentX, y: state.y },
    end: { x: state.contentX + state.contentWidth, y: state.y },
    thickness: theme.borderWidth,
    color: theme.border
  });
  state.y -= mmToPt(state.project.pageSettings.paragraphSpacingMm + 2);
}

async function drawImageBlock(state: PdfRenderState, block: PdfImageBlock): Promise<void> {
  if (!block.src) {
    return;
  }

  const image = await embedImage(state.pdfDoc, block.src);
  const maxWidth = state.pageWidth;
  const contentHeight = state.contentTop - state.contentBottom;
  const maxHeight = Math.min(Math.max(mmToPt(state.project.pageSettings.imageMaxHeightMm), contentHeight), state.contentTop - mmToPt(2));
  const requestedWidth = block.width ? Math.min(maxWidth, block.width * 0.75) : maxWidth;
  const requestedHeight = block.height ? Math.min(maxHeight, block.height * 0.75) : maxHeight;
  const scale = Math.min(requestedWidth / image.width, requestedHeight / image.height, maxHeight / image.height, 1);
  let width = image.width * scale;
  let height = image.height * scale;
  const paragraphGap = mmToPt(state.project.pageSettings.paragraphSpacingMm + 2);
  const remainingHeight = Math.max(0, state.y - state.contentBottom - paragraphGap);
  const minReadableHeight = mmToPt(18);

  if (height > remainingHeight && remainingHeight >= minReadableHeight) {
    const fitScale = remainingHeight / height;
    width *= fitScale;
    height *= fitScale;
  }

  ensureVerticalSpace(state, height);
  state.page.drawImage(image, {
    x: (state.pageWidth - width) / 2,
    y: state.y - height,
    width,
    height
  });
  state.y -= height + paragraphGap;
}

async function drawQrBlock(state: PdfRenderState, block: PdfQrBlock): Promise<void> {
  const QRCode = await import("qrcode");
  const theme = qrPdfTheme(state, block.template);
  const src =
    block.src ||
    (await QRCode.toDataURL(block.url, {
      margin: 1,
      width: 420,
      color: { dark: theme.qrDark, light: "#ffffff" }
    }));
  const image = await embedImage(state.pdfDoc, src);
  const requestedCardWidth = block.width ? block.width * 0.75 : mmToPt(74);
  const cardWidth = Math.min(state.contentWidth, requestedCardWidth);
  const contentHeight = state.contentTop - state.contentBottom;
  const requestedCardHeight = block.height ? Math.min(contentHeight, Math.max(mmToPt(24), block.height * 0.75)) : null;
  const cardPadding = mmToPt(4);
  const labelSize = 7;
  const bodyTextSize = 8;
  const urlSize = 6;
  const bodyGap = mmToPt(4);
  const labelHeight = labelSize * 1.35;
  const labelGap = mmToPt(2);
  const availableBodyHeight = requestedCardHeight ? Math.max(mmToPt(12), requestedCardHeight - cardPadding * 2 - labelHeight - labelGap) : mmToPt(23);
  const qrSize = Math.min(mmToPt(23), Math.max(mmToPt(14), availableBodyHeight));
  const captionX = state.contentX + (state.contentWidth - cardWidth) / 2 + cardPadding + qrSize + bodyGap;
  const captionWidth = Math.max(mmToPt(18), cardWidth - cardPadding * 2 - qrSize - bodyGap);
  const titleLineHeight = bodyTextSize * 1.35;
  const descriptionLineHeight = urlSize * 1.35;
  const rawTitleLines = wrapText(block.title, state.uiFont, bodyTextSize, captionWidth).slice(0, 2);
  const maxTitleLines = requestedCardHeight ? Math.max(1, Math.min(rawTitleLines.length, Math.floor(availableBodyHeight / titleLineHeight))) : rawTitleLines.length;
  const titleLines = rawTitleLines.slice(0, maxTitleLines);
  const remainingTextHeight = Math.max(0, availableBodyHeight - titleLines.length * titleLineHeight);
  const maxDescriptionLines = requestedCardHeight ? Math.max(0, Math.min(2, Math.floor(remainingTextHeight / descriptionLineHeight))) : 2;
  const descriptionLines = wrapText(block.description, state.uiFont, urlSize, captionWidth).slice(0, maxDescriptionLines);
  const textHeight = titleLines.length * bodyTextSize * 1.35 + descriptionLines.length * urlSize * 1.35;
  const bodyHeight = Math.max(qrSize, textHeight);
  const cardHeight = requestedCardHeight ?? cardPadding * 2 + labelHeight + labelGap + bodyHeight;

  ensureVerticalSpace(state, cardHeight);
  const cardX = state.contentX + (state.contentWidth - cardWidth) / 2;
  const cardY = state.y - cardHeight;

  state.page.drawRectangle({
    x: cardX,
    y: cardY,
    width: cardWidth,
    height: cardHeight,
    color: theme.background,
    borderColor: theme.border,
    borderWidth: theme.borderWidth
  });

  const label = truncateToWidth(block.label, state.uiFont, labelSize, cardWidth - cardPadding * 2);
  const labelWidth = state.uiFont.widthOfTextAtSize(label, labelSize);
  state.page.drawText(label, {
    x: cardX + (cardWidth - labelWidth) / 2,
    y: cardY + cardHeight - cardPadding - labelSize,
    font: state.uiFont,
    size: labelSize,
    color: theme.muted
  });

  const bodyTop = cardY + cardHeight - cardPadding - labelHeight - labelGap;
  state.page.drawImage(image, {
    x: cardX + cardPadding,
    y: bodyTop - qrSize,
    width: qrSize,
    height: qrSize
  });

  let textY = bodyTop - bodyTextSize;
  for (const line of titleLines) {
    state.page.drawText(line, { x: captionX, y: textY, font: state.uiFont, size: bodyTextSize, color: theme.ink });
    textY -= bodyTextSize * 1.35;
  }
  for (const line of descriptionLines) {
    state.page.drawText(line, { x: captionX, y: textY, font: state.uiFont, size: urlSize, color: theme.muted });
    textY -= urlSize * 1.35;
  }
  state.y -= cardHeight + mmToPt(state.project.pageSettings.paragraphSpacingMm + 1);
}

function qrPdfTheme(state: PdfRenderState, template: QrCardTemplateId): { background: RGB; border: RGB; ink: RGB; muted: RGB; borderWidth: number; qrDark: string } {
  if (template === "rain-letter") {
    return { background: state.colors.rainPaper, border: state.colors.rain, ink: state.colors.ink, muted: state.colors.rain, borderWidth: 0.9, qrDark: "#1f5c54" };
  }
  if (template === "antique-book") {
    return { background: state.colors.antiquePaper, border: state.colors.antiqueInk, ink: state.colors.antiqueInk, muted: state.colors.muted, borderWidth: 1.1, qrDark: "#3b2f23" };
  }
  if (template === "midnight") {
    return { background: state.colors.midnightPaper, border: state.colors.gold, ink: state.colors.midnightInk, muted: state.colors.midnightInk, borderWidth: 1, qrDark: "#141c2d" };
  }
  return { background: state.colors.white, border: state.colors.ink, ink: state.colors.ink, muted: state.colors.muted, borderWidth: 0.8, qrDark: "#24211d" };
}

function tocPdfTheme(state: PdfRenderState, style: TocStyleId): { border: RGB; ink: RGB; muted: RGB; accent: RGB; borderWidth: number } {
  if (style === "rain") {
    return { border: state.colors.ink, ink: state.colors.ink, muted: state.colors.muted, accent: state.colors.ink, borderWidth: 0.9 };
  }
  if (style === "antique") {
    return { border: state.colors.ink, ink: state.colors.ink, muted: state.colors.muted, accent: state.colors.ink, borderWidth: 1.1 };
  }
  if (style === "midnight") {
    return { border: state.colors.ink, ink: state.colors.ink, muted: state.colors.muted, accent: state.colors.ink, borderWidth: 1 };
  }
  return { border: state.colors.ink, ink: state.colors.ink, muted: state.colors.muted, accent: state.colors.ink, borderWidth: 0.8 };
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

function normalizePdfText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

  template.content.querySelectorAll("section[data-type='table-of-contents'],p,h1,h2,h3,li,blockquote,div[data-type='page-break'],figure[data-type='qr-card'],img").forEach((node) => {
    const element = node as HTMLElement;
    if (element.closest("section[data-type='table-of-contents']") && !element.matches("section[data-type='table-of-contents']")) {
      return;
    }

    if (element.matches("div[data-type='page-break']")) {
      blocks.push({ kind: "pageBreak" });
      return;
    }

    if (hasPageBreakBefore(element)) {
      blocks.push({ kind: "pageBreak" });
    }

    if (element.matches("figure[data-type='qr-card']")) {
      blocks.push({
        kind: "qr",
        url: element.dataset.url ?? "",
        title: element.dataset.title ?? element.querySelector(".qr-card-title")?.textContent ?? "QRリンク",
        description: element.dataset.description ?? element.querySelector(".qr-card-description")?.textContent ?? "",
        src: element.dataset.src ?? element.querySelector("img")?.getAttribute("src") ?? "",
        label: element.dataset.label ?? "Umbrella Parade 記録室",
        template: parseQrTemplate(element.dataset.template),
        width: parseHtmlDimension(element.dataset.width ?? element.style.width),
        height: parseHtmlDimension(element.dataset.height ?? element.style.height)
      });
      return;
    }

    if (element.matches("section[data-type='table-of-contents']")) {
      blocks.push({
        kind: "toc",
        title: element.dataset.title ?? element.querySelector(".toc-title")?.textContent ?? "目次",
        subtitle: "",
        style: parseTocStyle(element.dataset.style),
        fontSizePt: parseHtmlDimension(element.dataset.fontSizePt ?? null),
        titleGapPt: parseHtmlDimension(element.dataset.titleGapPt ?? null),
        items: parseTocEntries(element)
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
        alt: element.getAttribute("alt") ?? element.getAttribute("title") ?? "",
        width: parseHtmlDimension(element.getAttribute("width") ?? element.style.width),
        height: parseHtmlDimension(element.getAttribute("height") ?? element.style.height)
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

function parseHtmlDimension(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseQrTemplate(value: string | undefined): QrCardTemplateId {
  return value === "rain-letter" || value === "antique-book" || value === "midnight" || value === "umbrella" ? value : "umbrella";
}

function parseTocStyle(value: string | undefined): TocStyleId {
  return value === "rain" || value === "antique" || value === "midnight" || value === "classic" ? value : "classic";
}

function parseTocEntries(element: HTMLElement): TocExportEntry[] {
  const savedItems = element.dataset.items;
  if (savedItems) {
    try {
      const parsed = JSON.parse(savedItems) as Array<Partial<TocExportEntry>>;
      return parsed
        .map((item) => ({
          title: typeof item.title === "string" ? item.title : "",
          page: typeof item.page === "number" && Number.isFinite(item.page) ? item.page : null
        }))
        .filter((item) => item.title);
    } catch {
      // Fall through to DOM parsing.
    }
  }

  return [...element.querySelectorAll<HTMLElement>(".toc-entry")]
    .map((entry) => {
      const page = Number.parseInt(entry.querySelector(".toc-entry-page")?.textContent?.trim() ?? "", 10);
      return {
        title: entry.querySelector(".toc-entry-title")?.textContent?.trim() ?? "",
        page: Number.isFinite(page) ? page : null
      };
    })
    .filter((item) => item.title);
}

function hasPageBreakBefore(element: HTMLElement): boolean {
  return element.dataset.pageBreakBefore === "true" || element.classList.contains("page-break-before");
}

function parseHtmlBlocks(html: string): Array<{ kind: "paragraph" | "heading" | "pageBreak"; text: string }> {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blocks: Array<{ kind: "paragraph" | "heading" | "pageBreak"; text: string }> = [];

  template.content.querySelectorAll("section[data-type='table-of-contents'],p,h1,h2,h3,li,blockquote,div[data-type='page-break'],figure[data-type='qr-card']").forEach((node) => {
    const element = node as HTMLElement;
    if (element.closest("section[data-type='table-of-contents']") && !element.matches("section[data-type='table-of-contents']")) {
      return;
    }

    if (element.matches("div[data-type='page-break']")) {
      blocks.push({ kind: "pageBreak", text: "" });
      return;
    }

    if (hasPageBreakBefore(element)) {
      blocks.push({ kind: "pageBreak", text: "" });
    }

    if (element.matches("section[data-type='table-of-contents']")) {
      const title = element.dataset.title ?? element.querySelector(".toc-title")?.textContent ?? "目次";
      blocks.push({ kind: "heading", text: title });
      parseTocEntries(element).forEach((item) => {
        blocks.push({ kind: "paragraph", text: `${item.title} .... ${item.page ?? ""}`.trim() });
      });
      return;
    }

    if (element.matches("figure[data-type='qr-card']")) {
      const title = element.dataset.title ?? element.querySelector(".qr-card-title")?.textContent ?? "QRリンク";
      const description = element.dataset.description ?? element.querySelector(".qr-card-description")?.textContent ?? "";
      blocks.push({ kind: "paragraph", text: description ? `${title}: ${description}` : title });
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
