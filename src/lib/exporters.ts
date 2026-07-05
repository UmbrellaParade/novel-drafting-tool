import type { ManuscriptProject } from "./types";
import { downloadBlob } from "./storage";
import { sanitizeFileName, stripHtml } from "./defaultProject";

const mmToTwip = (value: number) => Math.round(value * 56.6929133858);

type TocExportEntry = {
  title: string;
  page: number | null;
};

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
  line-break: normal;
  word-break: normal;
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
  white-space: nowrap;
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
    throw new Error("画像を取得できませんでした。");
  }

  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") ?? ""
  };
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
