import type { ManuscriptProject, PageNumberPosition } from "./types";
import { downloadBlob } from "./storage";
import { sanitizeFileName, stripHtml } from "./defaultProject";

const mmToTwip = (value: number) => Math.round(value * 56.6929133858);
const PX_PER_MM = 96 / 25.4;
const DEFAULT_DOCX_IMAGE_WIDTH_PX = 320;
const DOCX_QR_IMAGE_WIDTH_PX = 96;
const DOCX_PNG_OPTIMIZE_MIN_BYTES = 200_000;
const DOCX_JPEG_QUALITY = 0.92;

function pageNumberPositionParts(position: PageNumberPosition): { vertical: "top" | "bottom"; horizontal: "left" | "center" | "right" } {
  const [vertical, horizontal] = position.split("-") as ["top" | "bottom", "left" | "center" | "right"];
  return { vertical, horizontal };
}

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

type DocxTextSegment = {
  text: string;
  fontSizePt?: number;
  rubyText?: string;
};

type DocxBlock =
  | { kind: "paragraph" | "heading" | "tocHeading"; segments: DocxTextSegment[] }
  | {
      kind: "tocEntry";
      title: string;
      suffix: string;
      targetIndex: number;
      enableLink: boolean;
    }
  | { kind: "pageBreak"; text: "" }
  | { kind: "image"; src: string; alt: string; widthPx?: number; heightPx?: number }
  | {
      kind: "qrCard";
      title: string;
      description: string;
      src: string;
      widthPx?: number;
      heightPx?: number;
      titleFontSizePt?: number;
      descriptionFontSizePt?: number;
    };

type DocxModule = typeof import("docx");
type DocxParagraph = InstanceType<DocxModule["Paragraph"]>;
type DocxImageRun = InstanceType<DocxModule["ImageRun"]>;

const INTERNAL_DOCUMENT_CHAPTER_TITLE = "本文";

function isInternalDocumentChapterTitle(title: string): boolean {
  return title.trim() === INTERNAL_DOCUMENT_CHAPTER_TITLE;
}

export async function exportProjectDocx(project: ManuscriptProject): Promise<void> {
  const docx = await import("docx");
  const children: InstanceType<typeof docx.Paragraph>[] = [];
  const bodyFont = project.pageSettings.fontFamily === "noto-sans-jp" ? "Noto Sans JP" : "Noto Serif JP";
  const uiFont = "Noto Sans JP";
  const lineSpacingTwips = Math.round(project.pageSettings.fontSizePt * 20 * project.pageSettings.lineHeight);
  const paragraphAfterTwips = mmToTwip(project.pageSettings.paragraphSpacingMm);
  const contentWidthPx = Math.round(Math.max(20, project.pageSettings.pageWidthMm - project.pageSettings.marginLeftMm - project.pageSettings.marginRightMm) * PX_PER_MM);
  const maxImageHeightPx = Math.round(Math.max(30, project.pageSettings.imageMaxHeightMm) * PX_PER_MM);
  const parsedChapters = project.chapters.map((chapter) => ({
    chapter,
    blocks: parseDocxBlocks(chapter.content)
  }));
  const headingCount = parsedChapters.reduce(
    (count, { blocks }) => count + blocks.filter((block) => block.kind === "heading").length,
    0
  );
  let headingIndex = 0;

  for (const [chapterIndex, { chapter, blocks }] of parsedChapters.entries()) {
    if (chapterIndex > 0) {
      children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
    }

    const includeChapterTitle = chapter.title.trim().length > 0 && !isInternalDocumentChapterTitle(chapter.title);
    if (includeChapterTitle) {
      children.push(
        new docx.Paragraph({
          children: [
            new docx.TextRun({
              text: chapter.title,
              font: bodyFont,
              size: Math.round(project.pageSettings.fontSizePt * 2.6),
              color: "000000"
            })
          ],
          heading: docx.HeadingLevel.HEADING_1
        })
      );
    }

    for (const block of blocks) {
      if (block.kind === "pageBreak") {
        children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
        continue;
      }

      if (block.kind === "image") {
        const imageParagraph = await createDocxImageParagraph(docx, block, {
          maxWidthPx: contentWidthPx,
          maxHeightPx: maxImageHeightPx
        });
        if (imageParagraph) {
          children.push(imageParagraph);
        }
        continue;
      }

      if (block.kind === "qrCard") {
        const qrParagraph = await createDocxQrCardParagraph(docx, block, {
          maxWidthPx: contentWidthPx,
          maxHeightPx: maxImageHeightPx,
          font: bodyFont,
          fontSizePt: project.pageSettings.fontSizePt
        });
        children.push(...qrParagraph);
        continue;
      }

      if (block.kind === "tocEntry") {
        const titleRunOptions = {
          text: block.title,
          font: bodyFont,
          size: Math.round(project.pageSettings.fontSizePt * 2)
        };
        const title = block.enableLink && block.targetIndex < headingCount
          ? new docx.InternalHyperlink({
              anchor: docxHeadingBookmarkId(block.targetIndex),
              children: [
                new docx.TextRun({
                  ...titleRunOptions,
                  color: "0563C1",
                  underline: {
                    type: docx.UnderlineType.SINGLE,
                    color: "0563C1"
                  }
                })
              ]
            })
          : new docx.TextRun({
              ...titleRunOptions,
              color: "000000"
            });
        children.push(
          new docx.Paragraph({
            children: [
              title,
              ...(block.suffix
                ? [
                    new docx.TextRun({
                      text: block.suffix,
                      font: bodyFont,
                      size: Math.round(project.pageSettings.fontSizePt * 2),
                      color: "000000"
                    })
                  ]
                : [])
            ],
            spacing: {
              after: paragraphAfterTwips,
              line: lineSpacingTwips,
              lineRule: docx.LineRuleType.AT_LEAST
            }
          })
        );
        continue;
      }

      const textRuns = createDocxTextRuns(docx, block.segments, {
        font: bodyFont,
        defaultFontSizePt: project.pageSettings.fontSizePt,
        color: "000000"
      });
      const textChildren = block.kind === "heading"
        ? new docx.Bookmark({
            id: docxHeadingBookmarkId(headingIndex++),
            children: textRuns
          })
        : textRuns;

      children.push(
        new docx.Paragraph({
          children: Array.isArray(textChildren) ? textChildren : [textChildren],
          heading: block.kind === "heading" || block.kind === "tocHeading"
            ? includeChapterTitle
              ? docx.HeadingLevel.HEADING_2
              : docx.HeadingLevel.HEADING_1
            : undefined,
          spacing: {
            after: paragraphAfterTwips,
            line: lineSpacingTwips,
            lineRule: docx.LineRuleType.AT_LEAST
          }
        })
      );
    }
  }

  const pageNumberPosition = pageNumberPositionParts(project.pageSettings.pageNumberPosition);
  const pageNumberAlignment =
    pageNumberPosition.horizontal === "left"
      ? docx.AlignmentType.LEFT
      : pageNumberPosition.horizontal === "center"
        ? docx.AlignmentType.CENTER
        : docx.AlignmentType.RIGHT;
  const createPageNumberParagraph = () =>
    new docx.Paragraph({
      alignment: pageNumberAlignment,
      children: [
        new docx.TextRun({
          children: [docx.PageNumber.CURRENT],
          font: uiFont,
          size: 16,
          color: "7A7168"
        })
      ]
    });
  const headerChildren: InstanceType<typeof docx.Paragraph>[] = [];
  if (project.pageSettings.showPageNumber && pageNumberPosition.vertical === "top") {
    headerChildren.push(createPageNumberParagraph());
  }
  headerChildren.push(
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
  );
  const footerChildren: InstanceType<typeof docx.Paragraph>[] = [];
  if (project.pageSettings.showPageNumber && pageNumberPosition.vertical === "bottom") {
    footerChildren.push(createPageNumberParagraph());
  } else if (!project.pageSettings.showPageNumber) {
    footerChildren.push(
      new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        children: [
          new docx.TextRun({
            text: project.author,
            font: uiFont,
            size: 16,
            color: "7A7168"
          })
        ]
      })
    );
  }
  if (footerChildren.length === 0) {
    footerChildren.push(new docx.Paragraph({ children: [] }));
  }

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
            children: headerChildren
          })
        },
        footers: {
          default: new docx.Footer({
            children: footerChildren
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
            },
            textDirection: project.pageSettings.writingMode === "vertical"
              ? docx.PageTextDirectionType.TOP_TO_BOTTOM_RIGHT_TO_LEFT
              : docx.PageTextDirectionType.LEFT_TO_RIGHT_TOP_TO_BOTTOM
          }
        },
        children
      }
    ]
  });

  const blob = await docx.Packer.toBlob(document);
  downloadBlob(blob, `${sanitizeFileName(project.title)}_Kindle.docx`);
}

async function createDocxImageParagraph(
  docx: DocxModule,
  block: Extract<DocxBlock, { kind: "image" }>,
  options: { maxWidthPx: number; maxHeightPx: number }
): Promise<DocxParagraph | null> {
  const image = await createDocxImageRun(docx, block.src, {
    requestedWidthPx: block.widthPx,
    requestedHeightPx: block.heightPx,
    maxWidthPx: options.maxWidthPx,
    maxHeightPx: options.maxHeightPx,
    alt: block.alt
  });

  if (!image) {
    return null;
  }

  return new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: {
      before: mmToTwip(2),
      after: mmToTwip(2)
    },
    children: [image]
  });
}

async function createDocxQrCardParagraph(
  docx: DocxModule,
  block: Extract<DocxBlock, { kind: "qrCard" }>,
  options: { maxWidthPx: number; maxHeightPx: number; font: string; fontSizePt: number }
): Promise<DocxParagraph[]> {
  const paragraphs: DocxParagraph[] = [];

  if (block.title) {
    paragraphs.push(
      new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: mmToTwip(1) },
        children: [
          new docx.TextRun({
            text: block.title,
            bold: true,
            font: options.font,
            size: Math.round((block.titleFontSizePt ?? options.fontSizePt) * 2)
          })
        ]
      })
    );
  }

  if (block.src) {
    const image = await createDocxImageRun(docx, block.src, {
      requestedWidthPx: Math.min(block.widthPx ?? DOCX_QR_IMAGE_WIDTH_PX, options.maxWidthPx),
      requestedHeightPx: block.heightPx,
      maxWidthPx: options.maxWidthPx,
      maxHeightPx: options.maxHeightPx,
      alt: block.title,
      preserveOriginal: true
    });

    if (image) {
      paragraphs.push(
        new docx.Paragraph({
          alignment: docx.AlignmentType.CENTER,
          spacing: { after: mmToTwip(1) },
          children: [image]
        })
      );
    }
  }

  if (block.description) {
    paragraphs.push(
      new docx.Paragraph({
        alignment: docx.AlignmentType.CENTER,
        spacing: { after: mmToTwip(2) },
        children: [
          new docx.TextRun({
            text: block.description,
            font: options.font,
            size: Math.round((block.descriptionFontSizePt ?? options.fontSizePt * 0.9) * 2)
          })
        ]
      })
    );
  }

  if (paragraphs.length === 0) {
    paragraphs.push(
      new docx.Paragraph({
        children: [
          new docx.TextRun({
            text: block.title || "QR",
            font: options.font,
            size: Math.round(options.fontSizePt * 2)
          })
        ]
      })
    );
  }

  return paragraphs;
}

async function createDocxImageRun(
  docx: DocxModule,
  src: string,
  options: {
    requestedWidthPx?: number;
    requestedHeightPx?: number;
    maxWidthPx: number;
    maxHeightPx: number;
    alt: string;
    preserveOriginal?: boolean;
  }
): Promise<DocxImageRun | null> {
  try {
    const loaded = await loadImageBytes(src);
    const intrinsic = await readImageIntrinsicSize(src);
    const fallbackRatio = 0.75;
    const ratio = intrinsic && intrinsic.width > 0 && intrinsic.height > 0 ? intrinsic.height / intrinsic.width : fallbackRatio;
    let width = Math.round(options.requestedWidthPx ?? intrinsic?.width ?? DEFAULT_DOCX_IMAGE_WIDTH_PX);
    let height = Math.round(options.requestedHeightPx ?? width * ratio);
    width = Math.max(24, Math.min(options.maxWidthPx, width));
    height = Math.max(24, Math.min(options.maxHeightPx, height));

    if (height >= options.maxHeightPx && ratio > 0) {
      width = Math.max(24, Math.min(width, Math.round(height / ratio)));
    }

    const optimized = options.preserveOriginal
      ? null
      : await optimizeDocxPngAsJpeg(src, loaded.bytes, loaded.mimeType);
    const bytes = optimized?.bytes ?? loaded.bytes;
    const mimeType = optimized?.mimeType ?? loaded.mimeType;
    const imageType = docxImageTypeForMimeType(mimeType);
    if (!imageType) {
      return null;
    }

    return new docx.ImageRun({
      type: imageType,
      data: bytes,
      transformation: {
        width,
        height
      },
      altText: {
        name: options.alt || "image",
        title: options.alt,
        description: options.alt
      }
    });
  } catch {
    return null;
  }
}

async function optimizeDocxPngAsJpeg(
  src: string,
  originalBytes: Uint8Array,
  mimeType: string
): Promise<{ bytes: Uint8Array; mimeType: "image/jpeg" } | null> {
  if (
    typeof document === "undefined" ||
    typeof Image === "undefined" ||
    !normalizeImageMimeType(mimeType).includes("png") ||
    originalBytes.byteLength < DOCX_PNG_OPTIMIZE_MIN_BYTES
  ) {
    return null;
  }

  try {
    const image = await loadBrowserImage(src);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", DOCX_JPEG_QUALITY);
    });
    if (!blob || blob.size >= originalBytes.byteLength) {
      return null;
    }

    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mimeType: "image/jpeg"
    };
  } catch {
    return null;
  }
}

function loadBrowserImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = window.setTimeout(() => reject(new Error("Image load timed out")), 5000);
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Image load failed"));
    };
    image.src = src;
  });
}

function docxImageTypeForMimeType(mimeType: string): "jpg" | "png" | "gif" | "bmp" | null {
  const normalized = normalizeImageMimeType(mimeType);
  if (normalized.includes("jpeg") || normalized.includes("jpg")) {
    return "jpg";
  }
  if (normalized.includes("png")) {
    return "png";
  }
  if (normalized.includes("gif")) {
    return "gif";
  }
  if (normalized.includes("bmp")) {
    return "bmp";
  }
  return null;
}

function readImageIntrinsicSize(src: string): Promise<{ width: number; height: number } | null> {
  if (typeof Image === "undefined") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const image = new Image();
    const timeout = window.setTimeout(() => resolve(null), 2500);
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      resolve(null);
    };
    image.src = src;
  });
}

export async function exportProjectEpub(project: ManuscriptProject): Promise<void> {
  const assetState: EpubAssetState = { nextIndex: 1, assets: [], sourceMap: new Map() };
  const chapters: EpubChapter[] = [];
  const contentWidthPx = Math.max(
    1,
    (project.pageSettings.pageWidthMm - project.pageSettings.marginLeftMm - project.pageSettings.marginRightMm) * PX_PER_MM
  );

  for (const [chapterIndex, chapter] of project.chapters.entries()) {
    chapters.push(await buildEpubChapter(
      chapter.title,
      chapter.content,
      chapterIndex + 1,
      assetState,
      project.title,
      contentWidthPx,
      project.pageSettings.writingMode === "vertical"
    ));
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


async function buildEpubChapter(
  title: string,
  html: string,
  chapterNumber: number,
  assetState: EpubAssetState,
  navigationFallbackTitle: string,
  contentWidthPx: number,
  verticalWriting: boolean
): Promise<EpubChapter> {
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

    if (!image.closest("figure[data-type='qr-card']")) {
      normalizeEpubImageSize(image, contentWidthPx);
    }
  }

  template.content.querySelectorAll<HTMLElement>("figure[data-type='qr-card']").forEach((figure) => {
    figure.removeAttribute("data-src");
    ["src", "instanceid", "url", "template", "label", "description"].forEach((attribute) => {
      figure.removeAttribute(attribute);
    });
  });

  const navItems: EpubNavItem[] = [];
  const headings = [...template.content.querySelectorAll<HTMLElement>("h1")].filter((heading) => !heading.closest("[data-type='table-of-contents']"));
  if (headings.length === 0) {
    if (isInternalDocumentChapterTitle(title)) {
      navItems.push({
        title: navigationFallbackTitle.trim() || "原稿",
        href
      });
    } else {
      const heading = document.createElement("h1");
      heading.textContent = title;
      template.content.prepend(heading);
      headings.push(heading);
    }
  }

  headings.forEach((heading, headingIndex) => {
    const id = heading.id || `chapter-${chapterNumber}-heading-${headingIndex + 1}`;
    heading.id = id;
    navItems.push({
      title: heading.textContent?.trim() || title,
      href: `${href}#${id}`
    });
  });

  template.content.querySelectorAll<HTMLAnchorElement>("a[data-toc-target-index]").forEach((link) => {
    const targetIndex = Number.parseInt(link.dataset.tocTargetIndex ?? "", 10);
    const targetHeading = Number.isFinite(targetIndex) ? headings[targetIndex] : null;
    if (targetHeading?.id) {
      link.setAttribute("href", `#${targetHeading.id}`);
    } else {
      link.removeAttribute("href");
    }
    link.removeAttribute("role");
    link.removeAttribute("tabindex");
    link.removeAttribute("data-toc-target-index");
  });

  if (verticalWriting) {
    decorateVerticalEpubText(template.content);
  }

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

function decorateVerticalEpubText(root: DocumentFragment): void {
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }

  textNodes.forEach((textNode) => {
    if (textNode.parentElement?.closest(".vertical-ellipsis, .vertical-dash, .vertical-tate-chu-yoko")) {
      return;
    }
    const value = textNode.nodeValue ?? "";
    const matches = [
      ...Array.from(value.matchAll(/…+|[.．]{3,}|[―—─]+/g)).map((match) => ({
        index: match.index ?? 0,
        text: match[0],
        className: /[―—─]/.test(match[0]) ? "vertical-dash" : "vertical-ellipsis"
      })),
      ...Array.from(value.matchAll(/\d+/g))
        .filter((match) => match[0].length <= 2)
        .map((match) => ({ index: match.index ?? 0, text: match[0], className: "vertical-tate-chu-yoko" })),
      ...Array.from(value.matchAll(/[!?！？]{2}/g)).map((match) => ({
        index: match.index ?? 0,
        text: match[0],
        className: "vertical-tate-chu-yoko"
      }))
    ].sort((left, right) => left.index - right.index);
    if (matches.length === 0) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let offset = 0;
    matches.forEach((match) => {
      if (match.index < offset) {
        return;
      }
      if (match.index > offset) {
        fragment.append(document.createTextNode(value.slice(offset, match.index)));
      }
      const span = document.createElement("span");
      span.className = match.className;
      span.textContent = match.text;
      fragment.append(span);
      offset = match.index + match.text.length;
    });
    if (offset < value.length) {
      fragment.append(document.createTextNode(value.slice(offset)));
    }
    textNode.replaceWith(fragment);
  });
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
  const spineDirection = project.pageSettings.writingMode === "vertical" ? ' page-progression-direction="rtl"' : "";

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
  <spine${spineDirection}>
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
  const tocWritingMode = project.pageSettings.writingMode === "vertical" ? "vertical-rl" : "horizontal-tb";
  const tocTitleAlignment = project.pageSettings.writingMode === "vertical" && project.tocSettings.titlePosition === "start"
    ? "start"
    : "center";
  const verticalWritingCss = project.pageSettings.writingMode === "vertical"
    ? `  writing-mode: vertical-rl;
  text-orientation: mixed;
  text-combine-upright: none;`
    : "";
  const verticalTocPageNumberCss = project.pageSettings.writingMode === "vertical"
    ? "  transform: translateY(calc(0mm - var(--toc-page-number-offset, 0mm)));"
    : "";
  const verticalDashCss = project.pageSettings.writingMode === "vertical"
    ? `  display: inline-block;
  transform: rotate(90deg);
  transform-origin: center;`
    : "";

  return `body {
  color: #24211d;
  font-family: ${bodyFont};
  font-size: ${project.pageSettings.fontSizePt}pt;
  line-height: ${project.pageSettings.lineHeight};
  line-break: normal;
  word-break: normal;
  overflow-wrap: normal;
  hyphens: manual;
${verticalWritingCss}
}

p {
  margin: 0;
  margin-block-end: ${project.pageSettings.paragraphSpacingMm}mm;
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
  writing-mode: ${tocWritingMode};
}

.toc-title {
  margin: 0;
  text-align: ${tocTitleAlignment};
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
  display: flex;
  align-items: baseline;
  gap: 0.55em;
  width: 100%;
  margin: 0.35em 0;
}

.toc-entry-title {
  min-width: 0;
  overflow-wrap: anywhere;
}

.toc-entry-link {
  color: #0b57d0;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.16em;
}

.toc-entry-leader {
  flex: 0 1 var(--toc-leader-width, 2.8em);
  inline-size: var(--toc-leader-width, 2.8em);
  min-inline-size: 0;
  margin-inline-start: auto;
  border-block-end: 1px dotted currentColor;
  opacity: 0.7;
}

.toc-entry-page {
  flex: 0 0 auto;
  min-inline-size: 2.5em;
  color: currentColor;
  text-align: end;
${verticalTocPageNumberCss}
}

.manuscript-toc-plain {
  padding: 0;
  border: 0;
  box-shadow: none;
  background: transparent;
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

.manuscript-toc-ornate {
  padding: 30px 28px 26px;
  border: 2px solid #111111;
  box-shadow: inset 0 0 0 3px #ffffff, inset 0 0 0 5px #111111;
  background:
    radial-gradient(circle at 24px 24px, transparent 0 12px, #111111 13px 14px, transparent 15px) left top / 72px 72px no-repeat,
    radial-gradient(circle at 48px 24px, transparent 0 12px, #111111 13px 14px, transparent 15px) right top / 72px 72px no-repeat,
    radial-gradient(circle at 24px 48px, transparent 0 12px, #111111 13px 14px, transparent 15px) left bottom / 72px 72px no-repeat,
    radial-gradient(circle at 48px 48px, transparent 0 12px, #111111 13px 14px, transparent 15px) right bottom / 72px 72px no-repeat,
    linear-gradient(#111111 0 0) center 10px / calc(100% - 104px) 1px no-repeat,
    linear-gradient(#111111 0 0) center calc(100% - 10px) / calc(100% - 104px) 1px no-repeat,
    #ffffff;
}

.qr-card {
  display: block;
  width: min(100%, 74mm);
  max-width: 100%;
  margin: 1.2em auto;
  padding: 4mm;
  border: 1px solid #37312c;
  writing-mode: horizontal-tb;
}

nav {
  writing-mode: ${tocWritingMode};
}

.vertical-ellipsis {
  white-space: nowrap;
  text-orientation: mixed;
  font-feature-settings: "vert" 1;
}

.vertical-dash {
  white-space: nowrap;
  text-orientation: mixed;
  font-feature-settings: "vert" 1;
${verticalDashCss}
}

.vertical-tate-chu-yoko {
  text-combine-upright: all;
  -webkit-text-combine: horizontal;
  text-orientation: mixed;
  letter-spacing: 0;
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

.qr-card-label {
  font-size: var(--qr-label-font-size, 0.9em);
}

.qr-card-title {
  font-size: var(--qr-title-font-size, 1em);
}

.qr-card-description {
  font-size: var(--qr-description-font-size, 0.86em);
}

.qr-card-ornate {
  padding: 30px 28px 24px;
  border: 2px solid #111111;
  text-align: center;
  box-shadow: inset 0 0 0 3px #ffffff, inset 0 0 0 5px #111111;
  background:
    radial-gradient(circle at 24px 24px, transparent 0 12px, #111111 13px 14px, transparent 15px) left top / 72px 72px no-repeat,
    radial-gradient(circle at 48px 24px, transparent 0 12px, #111111 13px 14px, transparent 15px) right top / 72px 72px no-repeat,
    radial-gradient(circle at 24px 48px, transparent 0 12px, #111111 13px 14px, transparent 15px) left bottom / 72px 72px no-repeat,
    radial-gradient(circle at 48px 48px, transparent 0 12px, #111111 13px 14px, transparent 15px) right bottom / 72px 72px no-repeat,
    linear-gradient(#111111 0 0) center 10px / calc(100% - 104px) 1px no-repeat,
    linear-gradient(#111111 0 0) center calc(100% - 10px) / calc(100% - 104px) 1px no-repeat,
    #ffffff;
}

.qr-card-ornate .qr-card-body,
.qr-card-ornate .qr-card-caption {
  display: block;
}

.qr-card-ornate .qr-card-image {
  display: block;
  width: min(68%, 46mm);
  height: auto;
  margin: 0 auto 14px;
}

.qr-card-ornate .qr-card-caption {
  padding-left: 0;
}

.qr-card-ornate .qr-card-title {
  font-size: var(--qr-title-font-size, 1.18em);
  font-weight: bold;
}

.qr-card-url {
  display: none;
}`;
}

function normalizeEpubImageSize(image: HTMLImageElement, contentWidthPx: number): void {
  const wrapper = image.closest<HTMLElement>("[data-resize-wrapper]");
  const requestedWidthPx = readEpubRequestedWidthPx(wrapper) ?? readEpubRequestedWidthPx(image);
  if (!requestedWidthPx || !Number.isFinite(contentWidthPx) || contentWidthPx <= 0) {
    image.style.maxWidth = "100%";
    image.style.height = "auto";
    image.removeAttribute("height");
    return;
  }

  const widthPercent = Math.max(5, Math.min(100, (requestedWidthPx / contentWidthPx) * 100));
  const formattedWidth = `${Number(widthPercent.toFixed(2))}%`;

  if (wrapper) {
    wrapper.style.width = formattedWidth;
    wrapper.style.maxWidth = "100%";
    wrapper.style.height = "auto";
    wrapper.removeAttribute("width");
    wrapper.removeAttribute("height");
    wrapper.removeAttribute("data-width");
    wrapper.removeAttribute("data-height");
    image.style.width = "100%";
  } else {
    image.style.width = formattedWidth;
  }

  image.style.maxWidth = "100%";
  image.style.height = "auto";
  image.removeAttribute("width");
  image.removeAttribute("height");
  image.removeAttribute("data-width");
  image.removeAttribute("data-height");
}

function readEpubRequestedWidthPx(element: HTMLElement | null): number | undefined {
  if (!element) {
    return undefined;
  }

  const values = [element.dataset.width, element.getAttribute("width"), element.style.width];
  for (const value of values) {
    if (!value || value.trim().endsWith("%")) {
      continue;
    }
    const parsed = parseCssDimensionPx(value);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function docxHeadingBookmarkId(index: number): string {
  return `manuscript_heading_${index + 1}`;
}

function createDocxTextRuns(
  docx: DocxModule,
  segments: DocxTextSegment[],
  options: { font: string; defaultFontSizePt: number; color: string }
): InstanceType<DocxModule["TextRun"]>[] {
  const source = segments.length > 0 ? segments : [{ text: "" }];
  return source.map((segment) => {
    const fontSizePt = segment.fontSizePt ?? options.defaultFontSizePt;
    return new docx.TextRun({
      text: segment.rubyText ? `${segment.text}(${segment.rubyText})` : segment.text,
      font: options.font,
      size: Math.round(fontSizePt * 2),
      color: options.color
    });
  });
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

function tocLeaderText(element: HTMLElement): string {
  const leaderWidthMm = Number.parseFloat(element.dataset.leaderWidthMm ?? "");
  if (!Number.isFinite(leaderWidthMm) || leaderWidthMm < 0) {
    return " .... ";
  }

  const dotCount = Math.max(0, Math.min(12, Math.round(leaderWidthMm / 3)));
  return dotCount > 0 ? ` ${".".repeat(dotCount)} ` : " ";
}

function tocShowsPageNumbers(element: HTMLElement): boolean {
  return element.dataset.showPageNumbers !== "false";
}

function tocLinksEnabled(element: HTMLElement): boolean {
  return element.dataset.enableLinks === "true";
}

function parseDocxBlocks(html: string): DocxBlock[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  const blocks: DocxBlock[] = [];

  template.content.querySelectorAll("section[data-type='table-of-contents'],p,h1,h2,h3,li,blockquote,div[data-type='page-break'],figure[data-type='qr-card'],img").forEach((node) => {
    const element = node as HTMLElement;
    if (element.closest("section[data-type='table-of-contents']") && !element.matches("section[data-type='table-of-contents']")) {
      return;
    }

    if (element.matches("img") && element.closest("figure[data-type='qr-card']")) {
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
      const showPageNumbers = tocShowsPageNumbers(element);
      const enableLinks = tocLinksEnabled(element);
      const leaderText = showPageNumbers ? tocLeaderText(element) : "";
      blocks.push({ kind: "tocHeading", segments: [{ text: title }] });
      parseTocEntries(element).forEach((item, targetIndex) => {
        blocks.push({
          kind: "tocEntry",
          title: item.title,
          suffix: showPageNumbers ? `${leaderText}${item.page ?? ""}` : "",
          targetIndex,
          enableLink: enableLinks
        });
      });
      return;
    }

    if (element.matches("img")) {
      const image = readDocxImageBlock(element as HTMLImageElement);
      if (image) {
        blocks.push(image);
      }
      return;
    }

    if (element.matches("figure[data-type='qr-card']")) {
      const title = element.dataset.title ?? element.querySelector(".qr-card-title")?.textContent ?? "QRリンク";
      const description = element.dataset.description ?? element.querySelector(".qr-card-description")?.textContent ?? "";
      const image = element.querySelector<HTMLImageElement>("img");
      blocks.push({
        kind: "qrCard",
        title,
        description,
        src: element.dataset.src ?? image?.getAttribute("src") ?? "",
        widthPx: readElementDimensionPx(element, "width"),
        heightPx: readElementDimensionPx(element, "height"),
        titleFontSizePt: readElementFontSizePt(element, "titleFontSizePt"),
        descriptionFontSizePt: readElementFontSizePt(element, "descriptionFontSizePt")
      });
      return;
    }

    const segments = readDocxTextSegments(element);
    if (!segments.some((segment) => segment.text)) {
      return;
    }

    blocks.push({
      kind: element.matches("h1,h2,h3") ? "heading" : "paragraph",
      segments
    });
  });

  if (blocks.length === 0) {
    blocks.push({ kind: "paragraph", segments: [{ text: stripHtml(html) }] });
  }

  return blocks;
}

function readDocxTextSegments(element: HTMLElement): DocxTextSegment[] {
  const segments: DocxTextSegment[] = [];

  const visit = (node: Node, inheritedFontSizePt?: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text) {
        return;
      }
      const previous = segments.at(-1);
      if (previous && !previous.rubyText && previous.fontSizePt === inheritedFontSizePt) {
        previous.text += text;
      } else {
        segments.push({ text, fontSizePt: inheritedFontSizePt });
      }
      return;
    }

    if (!(node instanceof HTMLElement)) {
      return;
    }

    if (node.matches("br")) {
      segments.push({ text: "\n", fontSizePt: inheritedFontSizePt });
      return;
    }

    const fontSizePt = readDocxFontSizePt(node) ?? inheritedFontSizePt;
    if (node.matches("ruby")) {
      const rubyText = node.getAttribute("rt")?.trim()
        || node.dataset.rt?.trim()
        || node.querySelector("rt")?.textContent?.trim()
        || "";
      const clone = node.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("rt,rp").forEach((rubyElement) => rubyElement.remove());
      const baseText = node.getAttribute("base")?.trim()
        || node.dataset.base?.trim()
        || clone.textContent?.trim()
        || "";
      if (baseText) {
        segments.push({
          text: baseText,
          fontSizePt,
          rubyText: rubyText || undefined
        });
      }
      return;
    }

    node.childNodes.forEach((child) => visit(child, fontSizePt));
  };

  visit(element);
  return segments;
}

function readDocxFontSizePt(element: HTMLElement): number | undefined {
  const value = element.style.fontSize || element.dataset.fontSize;
  if (!value) {
    return undefined;
  }

  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }

  if (value.endsWith("px")) {
    return numeric * 0.75;
  }
  if (value.endsWith("mm")) {
    return numeric * (72 / 25.4);
  }
  if (value.endsWith("cm")) {
    return numeric * (720 / 25.4);
  }
  if (value.endsWith("in")) {
    return numeric * 72;
  }

  return numeric;
}

function readDocxImageBlock(image: HTMLImageElement): Extract<DocxBlock, { kind: "image" }> | null {
  const src = image.getAttribute("src") ?? "";
  if (!src) {
    return null;
  }

  return {
    kind: "image",
    src,
    alt: image.getAttribute("alt") ?? image.getAttribute("title") ?? "",
    widthPx: readElementDimensionPx(image, "width"),
    heightPx: readElementDimensionPx(image, "height")
  };
}

function readElementDimensionPx(element: HTMLElement, dimension: "width" | "height"): number | undefined {
  const datasetValue = dimension === "width" ? element.dataset.width : element.dataset.height;
  const attributeValue = element.getAttribute(dimension);
  const styleValue = element.style[dimension];

  return parseCssDimensionPx(datasetValue) ?? parseCssDimensionPx(attributeValue) ?? parseCssDimensionPx(styleValue);
}

function readElementFontSizePt(element: HTMLElement, datasetKey: "titleFontSizePt" | "descriptionFontSizePt"): number | undefined {
  const numeric = Number.parseFloat(element.dataset[datasetKey] ?? "");
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function parseCssDimensionPx(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  const numeric = Number.parseFloat(trimmed);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }

  if (trimmed.endsWith("mm")) {
    return Math.round(numeric * PX_PER_MM);
  }

  if (trimmed.endsWith("cm")) {
    return Math.round(numeric * PX_PER_MM * 10);
  }

  if (trimmed.endsWith("pt")) {
    return Math.round(numeric * (96 / 72));
  }

  return Math.round(numeric);
}
