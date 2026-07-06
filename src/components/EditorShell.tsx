"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import QRCode from "qrcode";
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudCog,
  FileDown,
  FileJson,
  FileText,
  FolderOpen,
  ListTree,
  Minus,
  Pencil,
  Plus,
  QrCode,
  Save,
  Trash2,
  XCircle
} from "lucide-react";
import { TiptapEditor, TiptapToolbar, type PasteLayoutHints } from "./TiptapEditor";
import { MANUSCRIPT_FONTS, PAGE_PRESETS, applyPreset, countManuscriptCharacters, createDefaultProject, estimatePageCount, isValidUrl, normalizeProject, runManuscriptChecks, sanitizeFileName } from "@/lib/defaultProject";
import type { Chapter, ManuscriptFontId, ManuscriptProject, PagePresetId, PageSettings, QrCardTemplateId, QrLink, TocSettings, TocStyleId } from "@/lib/types";
import { downloadBlob, exportProjectJson, loadProjectFromBrowser, readJsonFile, saveProjectToBrowser } from "@/lib/storage";
import { blobToDataUrl } from "@/lib/imageAssets";
import { buildManuscriptFontEmbedCss } from "@/lib/pdfFonts";
import {
  clearGoogleDriveSettings,
  connectGoogleDrive,
  hasBundledGoogleDriveSettings,
  isDriveConfigured,
  loadGoogleDriveSettings,
  resetGoogleDriveClient,
  saveGoogleDriveSettings,
  type DriveFolder,
  type GoogleDriveSettings
} from "@/lib/googleDrive";
import { exportProjectDocx, exportProjectEpub } from "@/lib/exporters";

type MobileTab = "draft" | "chapters" | "check";

type DriveClient = Awaited<ReturnType<typeof connectGoogleDrive>>;

const tabLabels: Record<MobileTab, string> = {
  draft: "本文",
  chapters: "目次",
  check: "QR・確認"
};

const PAGE_GAP_MM = 14;
const MAX_PAGE_FRAMES = 160;
const DOCUMENT_CHAPTER_TITLE = "本文";
const AUTOSAVE_DELAY_MS = 1600;
const CONTENT_COMMIT_DELAY_MS = 450;
const LAYOUT_REFRESH_DELAY_MS = 650;
const FAST_EDITING_RESET_MS = 3000;
const PAGE_SCROLL_ALIGN_TOLERANCE_PX = 1.5;
const PAGE_PROGRAMMATIC_SCROLL_SUPPRESS_MS = 450;
const PAGE_USER_SCROLL_WINDOW_MS = 900;
const PDF_EXPORT_DPI = 300;
const MANGA_PRESETS = new Set<PagePresetId>(["shimauma-a6-manga", "shimauma-a5-manga"]);

type OutlineItem = {
  id: string;
  title: string;
  index: number;
};

type TocEntry = OutlineItem & {
  page: number | null;
};

type PageSpread = {
  id: string;
  pages: number[];
};

type QrDraft = {
  name: string;
  url: string;
  description: string;
  category: string;
  template: QrCardTemplateId;
};

type PdfExportSnapshot = {
  project: ManuscriptProject;
  chapter: Chapter;
  sectionTitles: string[];
  pageCount: number;
};

type PdfExportLayoutMeasurement = {
  pageCount: number;
  sectionTitles: string[];
};

type RasterPdfBuildResult = {
  bytes: Uint8Array;
  pageCount: number;
  fileName: string;
};

type RasterPdfBuildProgress = (pageIndex: number, totalPages: number) => void;

type SidebarPanelId = "toc" | "project" | "qr" | "drive" | "check";
type SidebarCollapseState = Record<SidebarPanelId, boolean>;

type PreviewPageMeasurement = {
  chapterId: string;
  contentRevision: number;
  pageSettings: PageSettings;
  count: number;
};

type ImageLayoutVars = {
  blockMargin: string;
  contentHeightOffset: string;
  fragmentationGuard: string;
  pageHeightLimit: string;
  fitPadding: string;
};

const SIDEBAR_COLLAPSE_STORAGE_KEY = "umbrella-parade:sidebar-collapsed-panels";
const DEFAULT_SIDEBAR_COLLAPSE_STATE: SidebarCollapseState = {
  toc: false,
  project: false,
  qr: false,
  drive: false,
  check: false
};

type DebouncedVersionedValue<T> = {
  value: T;
  revision: number;
};

function useDebouncedVersionedValue<T>(value: T, delayMs: number): DebouncedVersionedValue<T> {
  const [debouncedValue, setDebouncedValue] = useState<DebouncedVersionedValue<T>>({ value, revision: 0 });

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedValue((previous) => ({
        value,
        revision: previous.revision + 1
      }));
    }, delayMs);
    return () => window.clearTimeout(handle);
  }, [delayMs, value]);

  return debouncedValue;
}

function imageLayoutVarsForPage(settings: PageSettings): ImageLayoutVars {
  if (MANGA_PRESETS.has(settings.preset)) {
    return {
      blockMargin: "0mm",
      contentHeightOffset: "0mm",
      fragmentationGuard: "0mm",
      pageHeightLimit: "var(--page-height)",
      fitPadding: "0px"
    };
  }

  return {
    blockMargin: "4mm",
    contentHeightOffset: "4mm",
    fragmentationGuard: "0.25mm",
    pageHeightLimit: "calc(var(--page-height) - 8mm)",
    fitPadding: "8px"
  };
}

function readSidebarCollapseState(): SidebarCollapseState {
  if (typeof window === "undefined") {
    return DEFAULT_SIDEBAR_COLLAPSE_STATE;
  }

  try {
    const saved = window.localStorage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY);
    if (!saved) {
      return DEFAULT_SIDEBAR_COLLAPSE_STATE;
    }

    const parsed = JSON.parse(saved) as Partial<Record<SidebarPanelId, unknown>>;
    return {
      ...DEFAULT_SIDEBAR_COLLAPSE_STATE,
      toc: typeof parsed.toc === "boolean" ? parsed.toc : DEFAULT_SIDEBAR_COLLAPSE_STATE.toc,
      project: typeof parsed.project === "boolean" ? parsed.project : DEFAULT_SIDEBAR_COLLAPSE_STATE.project,
      qr: typeof parsed.qr === "boolean" ? parsed.qr : DEFAULT_SIDEBAR_COLLAPSE_STATE.qr,
      drive: typeof parsed.drive === "boolean" ? parsed.drive : DEFAULT_SIDEBAR_COLLAPSE_STATE.drive,
      check: typeof parsed.check === "boolean" ? parsed.check : DEFAULT_SIDEBAR_COLLAPSE_STATE.check
    };
  } catch {
    return DEFAULT_SIDEBAR_COLLAPSE_STATE;
  }
}

function saveSidebarCollapseState(state: SidebarCollapseState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable in private or restricted browsing modes.
  }
}

const QR_CARD_TEMPLATES: Record<QrCardTemplateId, { label: string; description: string; qrDark: string }> = {
  umbrella: {
    label: "記録室",
    description: "黒枠でシンプル",
    qrDark: "#24211d"
  },
  "rain-letter": {
    label: "雨の手紙",
    description: "青緑の便箋風",
    qrDark: "#1f5c54"
  },
  "antique-book": {
    label: "古書",
    description: "古紙と飾り罫",
    qrDark: "#3b2f23"
  },
  midnight: {
    label: "夜の祝祭",
    description: "濃紺に金の差し色",
    qrDark: "#141c2d"
  },
  ornate: {
    label: "装飾フレーム",
    description: "四隅の飾り罫と星の額縁",
    qrDark: "#111111"
  }
};

const EMPTY_QR_DRAFT: QrDraft = { name: "", url: "", description: "", category: "公式サイト", template: "umbrella" };
const EMPTY_DRIVE_SETTINGS: GoogleDriveSettings = { clientId: "", apiKey: "" };
const QR_DRAFT_STORAGE_KEY = "novel-drafting-tool:last-qr-draft";

const TOC_STYLE_OPTIONS: Record<TocStyleId, { label: string; description: string }> = {
  classic: {
    label: "細二重罫",
    description: "白黒印刷向けの端正な二重枠"
  },
  rain: {
    label: "雨粒の余白",
    description: "細かな点と罫線で雨の気配"
  },
  antique: {
    label: "記録室の角飾り",
    description: "四隅の飾り罫と古書風フレーム"
  },
  midnight: {
    label: "傘のアーチ",
    description: "天幕のようなアーチ罫"
  },
  ornate: {
    label: "装飾フレーム",
    description: "四隅の飾り罫と星を添えた額縁"
  }
};

function getQrCardTemplateId(value: QrCardTemplateId | undefined): QrCardTemplateId {
  return value && QR_CARD_TEMPLATES[value] ? value : "umbrella";
}

function reusableQrDraft(draft: QrDraft): QrDraft {
  return {
    ...EMPTY_QR_DRAFT,
    description: draft.description,
    category: draft.category,
    template: getQrCardTemplateId(draft.template)
  };
}

function readStoredQrDraft(): QrDraft {
  if (typeof window === "undefined") {
    return EMPTY_QR_DRAFT;
  }

  try {
    const raw = window.localStorage.getItem(QR_DRAFT_STORAGE_KEY);
    if (!raw) {
      return EMPTY_QR_DRAFT;
    }

    const parsed = JSON.parse(raw) as Partial<QrDraft>;
    return {
      ...EMPTY_QR_DRAFT,
      description: typeof parsed.description === "string" ? parsed.description : EMPTY_QR_DRAFT.description,
      category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category : EMPTY_QR_DRAFT.category,
      template: getQrCardTemplateId(parsed.template)
    };
  } catch {
    return EMPTY_QR_DRAFT;
  }
}

function storeReusableQrDraft(draft: QrDraft): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(QR_DRAFT_STORAGE_KEY, JSON.stringify(reusableQrDraft(draft)));
  } catch {
    // 保存できない環境では一時入力だけ使う。
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function chapterStartsWithH1(content: string): boolean {
  return /^\s*<h1[\s>]/i.test(content);
}

function normalizePageBreaks(content: string): string {
  if (typeof document === "undefined" || !content.includes("page-break")) {
    return content;
  }

  const template = document.createElement("template");
  template.innerHTML = content;
  template.content.querySelectorAll("div[data-type='page-break'], hr[data-type='page-break']").forEach((pageBreak) => {
    let target = pageBreak.nextElementSibling as HTMLElement | null;
    if (!target) {
      target = document.createElement("p");
      target.innerHTML = "<br>";
      pageBreak.after(target);
    }

    target.dataset.pageBreakBefore = "true";
    target.classList.add("page-break-before");
    pageBreak.remove();
  });

  return template.innerHTML;
}

function normalizeDocumentProject(project: ManuscriptProject): ManuscriptProject {
  const normalizedProject = normalizeProject(project);
  const savedChapters = Array.isArray(normalizedProject.chapters) ? normalizedProject.chapters : [];
  const chapters = (savedChapters.length
    ? savedChapters
    : [{ id: crypto.randomUUID(), title: DOCUMENT_CHAPTER_TITLE, content: "<p></p>" }]).map((chapter) => ({
    ...chapter,
    content: normalizePageBreaks(chapter.content ?? "<p></p>")
  }));

  if (chapters.length === 1) {
    const [chapter] = chapters;
    return {
      ...normalizedProject,
      chapters: [{ ...chapter, title: DOCUMENT_CHAPTER_TITLE }],
      activeChapterId: chapter.id
    };
  }

  const documentId = chapters[0].id || crypto.randomUUID();
  const content = chapters
    .map((chapter) => {
      const title = (chapter.title ?? "").trim() || DOCUMENT_CHAPTER_TITLE;
      const body = (chapter.content ?? "").trim() || "<p></p>";
      return chapterStartsWithH1(body) ? body : `<h1>${escapeHtml(title)}</h1>${body}`;
    })
    .join("");

  return {
    ...normalizedProject,
    chapters: [
      {
        id: documentId,
        title: DOCUMENT_CHAPTER_TITLE,
        content
      }
    ],
    activeChapterId: documentId
  };
}

function extractOutlineItems(html: string): OutlineItem[] {
  const htmlWithoutToc = html.replace(/<section\b[^>]*data-type=["']table-of-contents["'][\s\S]*?<\/section>/gi, "");
  if (typeof document === "undefined") {
    return [...htmlWithoutToc.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match, index) => ({
      id: `heading-${index}`,
      title: match[1].replace(/<[^>]*>/g, "").trim() || `見出し ${index + 1}`,
      index
    }));
  }

  const template = document.createElement("template");
  template.innerHTML = htmlWithoutToc;
  return [...template.content.querySelectorAll("h1")].map((heading, index) => ({
    id: `heading-${index}`,
    title: heading.textContent?.trim() || `見出し ${index + 1}`,
    index
  }));
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameNumberList(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildPageSpreads(pageCount: number): PageSpread[] {
  const safePageCount = Math.max(1, pageCount);
  if (safePageCount === 1) {
    return [{ id: "page-1", pages: [0] }];
  }

  const spreads: PageSpread[] = [{ id: "page-1", pages: [0] }];
  for (let pageIndex = 1; pageIndex < safePageCount; pageIndex += 2) {
    const pages = pageIndex + 1 < safePageCount ? [pageIndex, pageIndex + 1] : [pageIndex];
    spreads.push({ id: pages.map((page) => `page-${page + 1}`).join("-"), pages });
  }
  return spreads;
}

function findSpreadIndexForPage(spreads: PageSpread[], pageIndex: number): number {
  const foundIndex = spreads.findIndex((spread) => spread.pages.includes(pageIndex));
  return foundIndex >= 0 ? foundIndex : Math.max(0, spreads.length - 1);
}

function pageSpreadLabel(spread: PageSpread): string {
  if (spread.pages.length <= 1) {
    return String((spread.pages[0] ?? 0) + 1);
  }

  return `${(spread.pages[0] ?? 0) + 1}-${(spread.pages[spread.pages.length - 1] ?? 0) + 1}`;
}

function uint8ArrayToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

const mmToPt = (value: number) => (value * 72) / 25.4;

async function nextAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function waitForPdfExportDom(root: HTMLElement): Promise<void> {
  await document.fonts?.ready;
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
  await Promise.all(
    images.map((image) => {
      if (image.complete && image.naturalWidth > 0) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      });
    })
  );
}
async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) {
        resolve(nextBlob);
      } else {
        reject(new Error("PDF用ページ画像を作成できませんでした。"));
      }
    }, "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

// html-to-imageはクローン時に font-size を「floor(値)-0.1px」に縮める内部ハックを持つ
// （例: 11.7333px → 10.9px）。日本語組版では字送りが変わり折り返しがズレるため、
// 生成されたSVGを元DOMと突き合わせて正しいfont-sizeへ書き戻す。
function correctSvgFontSizes(originalRoot: HTMLElement, svgDataUrl: string): string {
  const commaIndex = svgDataUrl.indexOf(",");
  const svgText = decodeURIComponent(svgDataUrl.slice(commaIndex + 1));
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const cloneRoot = parsed.querySelector("foreignObject > *");
  if (!cloneRoot) {
    return svgDataUrl;
  }

  // クローン側には擬似要素・フォント用の<style>タグが追加されるため除外して比較する
  const withoutStyleTags = (elements: Element[]) => elements.filter((element) => element.tagName.toLowerCase() !== "style");
  const originals = withoutStyleTags([originalRoot, ...Array.from(originalRoot.querySelectorAll("*"))]);
  const clones = withoutStyleTags([cloneRoot, ...Array.from(cloneRoot.querySelectorAll("*"))]);
  if (originals.length !== clones.length) {
    window.console.warn(`PDF書き出し: フォントサイズ補正をスキップ（要素数不一致 ${originals.length} vs ${clones.length}）`);
    return svgDataUrl;
  }

  for (let index = 0; index < originals.length; index += 1) {
    const original = originals[index];
    const clone = clones[index];
    if (original.tagName.toLowerCase() !== clone.tagName.toLowerCase()) {
      return svgDataUrl;
    }

    const fontSize = window.getComputedStyle(original).fontSize;
    if (fontSize) {
      // style属性内で後に書いた宣言が優先される
      clone.setAttribute("style", `${clone.getAttribute("style") ?? ""}; font-size: ${fontSize};`);
    }
  }

  const fixedSvg = new XMLSerializer().serializeToString(parsed);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fixedSvg)}`;
}

async function svgDataUrlToCanvas(svgDataUrl: string, widthPx: number, heightPx: number, pixelRatio: number): Promise<HTMLCanvasElement> {
  const image = new Image();
  image.decoding = "sync";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("PDF用ページ画像を描画できませんでした。"));
    image.src = svgDataUrl;
  });
  // SVG内に埋め込んだWebフォントの読み込みを確実に反映させる
  await nextAnimationFrame();

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(widthPx * pixelRatio));
  canvas.height = Math.max(1, Math.round(heightPx * pixelRatio));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("PDF用ページ画像を作成できませんでした。");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// 画像srcをdata URIに変換しておく（SVG foreignObject描画は外部参照を解決できないため）
async function inlineImagesForPdfExport(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
  await Promise.all(
    images.map(async (image) => {
      const src = image.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:")) {
        return;
      }

      try {
        const blob = await (await fetch(src)).blob();
        image.setAttribute("src", await blobToDataUrl(blob));
      } catch {
        // 変換できない画像は元のsrcのまま描画を試みる
      }
    })
  );
}

async function buildRasterPdfFromDom(root: HTMLElement, snapshot: PdfExportSnapshot, onProgress?: RasterPdfBuildProgress): Promise<RasterPdfBuildResult> {
  // html2canvasは独自のテキスト描画のため日本語・ルビの折り返しが編集画面とズレる。
  // html-to-image(SVG foreignObject)はブラウザ本来のレンダリングをそのまま使うので、
  // 編集画面と同じ改行・同じルビ配置でPDF化できる。
  const [htmlToImage, { PDFDocument }] = await Promise.all([import("html-to-image"), import("pdf-lib")]);
  await inlineImagesForPdfExport(root);
  await waitForPdfExportDom(root);

  const pageElement = root.querySelector<HTMLElement>(".pdf-export-page");
  const flow = root.querySelector<HTMLElement>(".pdf-export-flow");
  if (!pageElement || !flow) {
    throw new Error("PDF用ページを作成できませんでした。");
  }

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(snapshot.project.title);

  // フォント埋め込みCSSは全ページ共通なので1回だけ作る。
  // 原稿に含まれる文字のサブセットだけを埋め込む（全部埋め込むと数十MBになり
  // SVG内でフォントが適用されず、編集画面と折り返しがズレる）。
  let fontEmbedCSS: string | undefined;
  try {
    fontEmbedCSS = await buildManuscriptFontEmbedCss(root.textContent ?? "");
  } catch {
    // 取得に失敗した場合はhtml-to-image標準の埋め込みに任せる
    fontEmbedCSS = undefined;
  }

  const pageSettings = snapshot.project.pageSettings;
  const pageWidthPt = mmToPt(snapshot.project.pageSettings.pageWidthMm);
  const pageHeightPt = mmToPt(snapshot.project.pageSettings.pageHeightMm);
  const renderScale = PDF_EXPORT_DPI / 96;
  const contentWidthMm = Math.max(1, pageSettings.pageWidthMm - pageSettings.marginLeftMm - pageSettings.marginRightMm);
  const pagePitchMm = contentWidthMm + pageSettings.marginLeftMm + pageSettings.marginRightMm + PAGE_GAP_MM;

  for (let pageIndex = 0; pageIndex < snapshot.pageCount; pageIndex += 1) {
    pageElement.dataset.pageNumber = String(pageIndex + 1);
    const header = pageElement.querySelector<HTMLElement>(".pdf-export-page-header");
    if (header) {
      header.replaceChildren();
      const title = snapshot.sectionTitles[pageIndex] ?? "";
      if (title) {
        const span = document.createElement("span");
        span.textContent = title;
        header.append(span);
      }
    }

    const footer = pageElement.querySelector<HTMLElement>(".pdf-export-page-footer");
    if (footer) {
      footer.replaceChildren();
      if (pageSettings.showPageNumber) {
        const span = document.createElement("span");
        span.textContent = String(pageIndex + 1);
        footer.append(span);
      }
    }

    flow.style.marginLeft = `-${pageIndex * pagePitchMm}mm`;
    onProgress?.(pageIndex, snapshot.pageCount);
    await nextAnimationFrame();

    const pageRect = pageElement.getBoundingClientRect();
    const svgDataUrl = await htmlToImage.toSvg(pageElement, {
      backgroundColor: "#ffffff",
      fontEmbedCSS,
      skipAutoScale: true,
      cacheBust: false
    });
    const correctedSvg = correctSvgFontSizes(pageElement, svgDataUrl);
    const canvas = await svgDataUrlToCanvas(correctedSvg, pageRect.width, pageRect.height, renderScale);
    const imageBytes = await canvasToPngBytes(canvas);
    canvas.width = 0;
    canvas.height = 0;

    const image = await pdfDoc.embedPng(imageBytes);
    const pdfPage = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
    pdfPage.drawImage(image, {
      x: 0,
      y: 0,
      width: pageWidthPt,
      height: pageHeightPt
    });
  }

  const bytes = await pdfDoc.save();
  const pageCount = snapshot.pageCount;
  return {
    bytes: new Uint8Array(bytes),
    pageCount,
    fileName: `${sanitizeFileName(snapshot.project.title)}_book.pdf`
  };
}

function setPdfExportStyleVars(root: HTMLElement, snapshot: PdfExportSnapshot): void {
  const page = snapshot.project.pageSettings;
  const imageLayout = imageLayoutVarsForPage(page);
  const contentWidthMm = Math.max(1, page.pageWidthMm - page.marginLeftMm - page.marginRightMm);
  const columnGapMm = page.marginLeftMm + page.marginRightMm + PAGE_GAP_MM;
  const pagedContentWidthMm = contentWidthMm * snapshot.pageCount + columnGapMm * Math.max(0, snapshot.pageCount - 1);
  root.style.setProperty("--page-width", `${page.pageWidthMm}mm`);
  root.style.setProperty("--page-height", `${page.pageHeightMm}mm`);
  root.style.setProperty("--margin-top", `${page.marginTopMm}mm`);
  root.style.setProperty("--margin-bottom", `${page.marginBottomMm}mm`);
  root.style.setProperty("--margin-left", `${page.marginLeftMm}mm`);
  root.style.setProperty("--margin-right", `${page.marginRightMm}mm`);
  root.style.setProperty("--manuscript-font-family", MANUSCRIPT_FONTS[page.fontFamily ?? "noto-serif-jp"].css);
  root.style.setProperty("--manuscript-font-size", `${page.fontSizePt}pt`);
  root.style.setProperty("--ruby-font-size", `${page.rubySizePt}pt`);
  root.style.setProperty("--line-height", String(page.lineHeight));
  root.style.setProperty("--paragraph-spacing", `${page.paragraphSpacingMm}mm`);
  root.style.setProperty("--image-max-height", `${page.imageMaxHeightMm}mm`);
  root.style.setProperty("--image-block-margin", imageLayout.blockMargin);
  root.style.setProperty("--image-content-height-offset", imageLayout.contentHeightOffset);
  root.style.setProperty("--fragmentation-guard", imageLayout.fragmentationGuard);
  root.style.setProperty("--image-page-height-limit", imageLayout.pageHeightLimit);
  root.style.setProperty("--image-fit-padding", imageLayout.fitPadding);
  root.style.setProperty("--page-gap", `${PAGE_GAP_MM}mm`);
  root.style.setProperty("--content-width", "calc(var(--page-width) - var(--margin-left) - var(--margin-right))");
  root.style.setProperty("--content-height", "calc(var(--page-height) - var(--margin-top) - var(--margin-bottom))");
  root.style.setProperty("--column-gap", "calc(var(--margin-left) + var(--margin-right) + var(--page-gap))");
  root.style.setProperty("--paged-content-width", `${pagedContentWidthMm}mm`);
}

function createPdfExportDom(snapshot: PdfExportSnapshot): HTMLElement {
  const page = snapshot.project.pageSettings;
  const root = document.createElement("div");
  root.className = "pdf-export-document";
  root.lang = "ja";
  root.setAttribute("aria-hidden", "true");
  setPdfExportStyleVars(root, snapshot);

  for (let pageIndex = 0; pageIndex < 1; pageIndex += 1) {
    const pageElement = document.createElement("section");
    pageElement.className = "pdf-export-page";
    pageElement.dataset.pageNumber = String(pageIndex + 1);

    const header = document.createElement("header");
    header.className = "pdf-export-page-header";
    const title = snapshot.sectionTitles[pageIndex] ?? "";
    if (title) {
      const span = document.createElement("span");
      span.textContent = title;
      header.append(span);
    }
    pageElement.append(header);

    const contentWindow = document.createElement("div");
    contentWindow.className = "pdf-export-content-window";
    const flow = document.createElement("div");
    flow.className = "pdf-export-flow manuscript-prose";
    flow.innerHTML = snapshot.chapter.content;
    contentWindow.append(flow);
    pageElement.append(contentWindow);

    const footer = document.createElement("footer");
    footer.className = "pdf-export-page-footer";
    if (page.showPageNumber) {
      const span = document.createElement("span");
      span.textContent = String(pageIndex + 1);
      footer.append(span);
    }
    pageElement.append(footer);

    root.append(pageElement);
  }

  return root;
}

async function measurePdfExportLayout(snapshot: PdfExportSnapshot): Promise<PdfExportLayoutMeasurement> {
  const measurementRoot = createPdfExportDom({ ...snapshot, sectionTitles: [], pageCount: 1 });
  document.body.append(measurementRoot);
  try {
    await nextAnimationFrame();
    await waitForPdfExportDom(measurementRoot);
    await nextAnimationFrame();

    const contentWindow = measurementRoot.querySelector<HTMLElement>(".pdf-export-content-window");
    const flow = measurementRoot.querySelector<HTMLElement>(".pdf-export-flow");
    if (!contentWindow || !flow) {
      throw new Error("PDF用ページの測定に失敗しました。");
    }

    const contentWidth = contentWindow.getBoundingClientRect().width || contentWindow.offsetWidth;
    const computedColumnGap = Number.parseFloat(window.getComputedStyle(flow).columnGap);
    const columnGap = Number.isFinite(computedColumnGap) ? computedColumnGap : 0;
    const pagePitch = contentWidth + columnGap;
    if (contentWidth <= 0 || pagePitch <= 0) {
      throw new Error("PDF用ページサイズを測定できませんでした。");
    }

    const pageCount = Math.max(1, Math.min(Math.ceil((flow.scrollWidth + 1) / pagePitch), MAX_PAGE_FRAMES));
    const sectionTitles = Array.from({ length: pageCount }, () => "");
    const firstContentLeft = contentWindow.getBoundingClientRect().left;

    flow.querySelectorAll<HTMLElement>("h1").forEach((heading) => {
      if (heading.closest("[data-type='table-of-contents']")) {
        return;
      }

      const title = heading.textContent?.trim();
      if (!title) {
        return;
      }

      const pageIndex = Math.max(0, Math.min(pageCount - 1, Math.floor((heading.getBoundingClientRect().left - firstContentLeft + 2) / pagePitch)));
      for (let index = pageIndex; index < sectionTitles.length; index += 1) {
        sectionTitles[index] = title;
      }
    });

    return { pageCount, sectionTitles };
  } finally {
    measurementRoot.remove();
  }
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

function readCssLengthPx(host: HTMLElement, variableName: string): number {
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.width = `var(${variableName})`;
  probe.style.height = "0";
  host.appendChild(probe);
  const width = probe.offsetWidth || probe.getBoundingClientRect().width;
  probe.remove();
  return Number.isFinite(width) && width > 0 ? width : 0;
}

const PREVIEW_PAGE_CONTENT_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "p",
  "li",
  "blockquote",
  "section[data-type='table-of-contents']",
  "figure",
  "img"
].join(",");

function hasPreviewPageContent(element: HTMLElement): boolean {
  if (element.matches("img,figure,section[data-type='table-of-contents'],[data-type='qr-card'],.qr-card")) {
    return true;
  }

  if (element.querySelector("img,figure,[data-type='qr-card'],.qr-card")) {
    return true;
  }

  return (element.textContent ?? "").trim().length > 0;
}

function measureOccupiedPreviewPages(prose: HTMLElement, firstPageLeft: number, visualPagePitch: number): number | null {
  if (visualPagePitch <= 0) {
    return null;
  }

  let lastOccupiedPageIndex = -1;
  prose.querySelectorAll<HTMLElement>(PREVIEW_PAGE_CONTENT_SELECTOR).forEach((element) => {
    if (!hasPreviewPageContent(element)) {
      return;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const pageIndex = Math.floor((rect.right - firstPageLeft - 2) / visualPagePitch);
    if (pageIndex >= 0) {
      lastOccupiedPageIndex = Math.max(lastOccupiedPageIndex, pageIndex);
    }
  });

  return lastOccupiedPageIndex >= 0 ? lastOccupiedPageIndex + 1 : null;
}

function googleDriveSetupMessage(): string {
  return [
    "この公開版では、Google Drive連携の運営側設定がまだ入っていません。",
    "",
    "利用者がGoogle CloudでAPIキーを取得する必要はありません。",
    "運営側でOAuthクライアントIDとAPIキーをアプリに組み込むと、利用者はDriveボタンからGoogle認証するだけで保存できます。",
    "",
    "管理者向け: NEXT_PUBLIC_GOOGLE_CLIENT_ID と NEXT_PUBLIC_GOOGLE_API_KEY を設定して再ビルドしてください。"
  ].join("\n");
}

function tocItemsJson(entries: TocEntry[]): string {
  return JSON.stringify(entries.map((entry) => ({ title: entry.title, page: entry.page })));
}

function tableOfContentsAttrs(settings: TocSettings, entries: TocEntry[]) {
  return {
    title: settings.title.trim() || "目次",
    subtitle: "",
    style: settings.style,
    fontSizePt: settings.fontSizePt ?? null,
    titleGapPt: settings.titleGapPt ?? null,
    items: tocItemsJson(entries)
  };
}

function shouldStartInsertedBlockOnNewPage(editor: Editor, insertPosition: number): boolean {
  if (insertPosition <= 1) {
    return false;
  }

  if (editor.state.doc.textBetween(0, insertPosition, "", "").trim()) {
    return true;
  }

  let hasAtomicContentBefore = false;
  editor.state.doc.nodesBetween(0, insertPosition, (node, position) => {
    if (hasAtomicContentBefore || position >= insertPosition) {
      return false;
    }

    if (node.isAtom && !node.isText) {
      hasAtomicContentBefore = true;
      return false;
    }

    return true;
  });

  return hasAtomicContentBefore;
}

function syncTableOfContentsNodes(editor: Editor, settings: TocSettings, entries: TocEntry[]): boolean {
  const attrs = tableOfContentsAttrs(settings, entries);
  let changed = false;

  editor
    .chain()
    .command(({ state, tr }) => {
      state.doc.descendants((node, position) => {
        if (node.type.name !== "tableOfContents") {
          return;
        }

        const nextAttrs = { ...node.attrs, ...attrs };
        const isSame =
          node.attrs.title === nextAttrs.title &&
          node.attrs.subtitle === nextAttrs.subtitle &&
          node.attrs.style === nextAttrs.style &&
          node.attrs.fontSizePt === nextAttrs.fontSizePt &&
          node.attrs.titleGapPt === nextAttrs.titleGapPt &&
          node.attrs.items === nextAttrs.items;
        if (!isSame) {
          tr.setNodeMarkup(position, undefined, nextAttrs, node.marks);
          changed = true;
        }
      });
      if (changed) {
        tr.setMeta("skipTypingActivity", true);
      }
      return changed;
    })
    .run();

  return changed;
}

export function EditorShell() {
  const [project, setProject] = useState<ManuscriptProject | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("draft");
  const [statusText, setStatusText] = useState("起動中");
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [driveClient, setDriveClient] = useState<DriveClient | null>(null);
  const [driveFolders, setDriveFolders] = useState<DriveFolder[]>([]);
  const [driveSettingsDraft, setDriveSettingsDraft] = useState<GoogleDriveSettings>(EMPTY_DRIVE_SETTINGS);
  const [collapsedPanels, setCollapsedPanels] = useState<SidebarCollapseState>(() => readSidebarCollapseState());
  const [measuredPages, setMeasuredPages] = useState<PreviewPageMeasurement | null>(null);
  const [pageSectionTitles, setPageSectionTitles] = useState<string[]>([]);
  const [headingPageNumbers, setHeadingPageNumbers] = useState<number[]>([]);
  const [pageFit, setPageFit] = useState({ scale: 1, width: 0, height: 0, pageStep: 0 });
  const [visibleSpreadIndex, setVisibleSpreadIndex] = useState(0);
  const [fastEditing, setFastEditing] = useState(false);
  const bundledDriveSettings = hasBundledGoogleDriveSettings();
  const pageStageRef = useRef<HTMLDivElement | null>(null);
  const visibleSpreadIndexRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollLockFrameRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(0);
  const programmaticPageScrollUntilRef = useRef(0);
  const lastUserPageScrollInputRef = useRef(0);
  const fastEditingRef = useRef(false);
  const editingScrollLockRef = useRef<{ top: number; left: number } | null>(null);
  const qrPanelRef = useRef<HTMLElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const pendingChapterContentRef = useRef<string | null>(null);
  const contentCommitTimerRef = useRef<number | null>(null);
  const fastEditingTimerRef = useRef<number | null>(null);
  // ページ設定（フォント・余白等）変更のdebounce用
  const pageSettingTimerRef = useRef<number | null>(null);
  const pendingPageSettingsRef = useRef<Partial<PageSettings>>({});

  useEffect(() => {
    let isMounted = true;

    void loadProjectFromBrowser()
      .then((restored) => {
        if (!isMounted) {
          return;
        }
        setProject(normalizeDocumentProject(restored ?? createDefaultProject()));
        setStatusText(restored ? "ブラウザ保存から復元" : "新規原稿");
      })
      .catch(() => {
        if (!isMounted) {
          return;
        }
        setProject(normalizeDocumentProject(createDefaultProject()));
        setStatusText("新規原稿");
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    setDriveSettingsDraft(loadGoogleDriveSettings());
  }, []);

  useEffect(() => {
    return () => {
      if (contentCommitTimerRef.current !== null) {
        window.clearTimeout(contentCommitTimerRef.current);
      }
      if (fastEditingTimerRef.current !== null) {
        window.clearTimeout(fastEditingTimerRef.current);
      }
      if (pageSettingTimerRef.current !== null) {
        window.clearTimeout(pageSettingTimerRef.current);
      }
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (scrollLockFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollLockFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    fastEditingRef.current = fastEditing;
  }, [fastEditing]);

  useEffect(() => {
    if (!project) {
      return;
    }

    const handle = window.setTimeout(() => {
      void saveProjectToBrowser(project)
        .then(() => {
          setStatusText(`ブラウザ保存 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`);
        })
        .catch((error) => {
          setStatusText("ブラウザ保存に失敗");
          window.console.error(error);
        });
    }, AUTOSAVE_DELAY_MS);

    return () => window.clearTimeout(handle);
  }, [project]);

  const activeChapter = useMemo(() => {
    if (!project) {
      return null;
    }
    return project.chapters[0] ?? null;
  }, [project]);
  const layoutPageSettings = project?.pageSettings ?? null;
  const layoutChapters = project?.chapters ?? null;
  const tocSettingsForSync = project?.tocSettings ?? null;
  const activeChapterContent = activeChapter?.content ?? "";
  const { value: layoutChapterContent, revision: layoutContentRevision } = useDebouncedVersionedValue(activeChapterContent, LAYOUT_REFRESH_DELAY_MS);
  const layoutProject = useMemo<ManuscriptProject | null>(() => {
    if (!layoutPageSettings || !layoutChapters || !activeChapter) {
      return null;
    }

    return {
      schemaVersion: 1,
      id: "layout-preview",
      title: "",
      subtitle: "",
      author: "",
      pageSettings: layoutPageSettings,
      chapters: layoutChapters.map((chapter, index) => (index === 0 ? { ...chapter, content: layoutChapterContent } : chapter)),
      activeChapterId: activeChapter.id,
      qrLinks: [],
      tocSettings: { title: "目次", subtitle: "", style: "classic" },
      updatedAt: ""
    };
  }, [activeChapter, layoutChapterContent, layoutChapters, layoutPageSettings]);
  const outlineItems = useMemo(() => extractOutlineItems(layoutChapterContent), [layoutChapterContent]);
  const tocEntries = useMemo<TocEntry[]>(
    () => outlineItems.map((item) => ({ ...item, page: headingPageNumbers[item.index] ?? null })),
    [headingPageNumbers, outlineItems]
  );

  const checks = useMemo(() => (layoutProject ? runManuscriptChecks(layoutProject) : []), [layoutProject]);
  const estimatedPages = useMemo(() => (layoutProject ? estimatePageCount(layoutProject) : 1), [layoutProject]);
  const characterCount = useMemo(() => (layoutProject ? countManuscriptCharacters(layoutProject) : 0), [layoutProject]);
  const measuredPageCount =
    measuredPages &&
    activeChapter &&
    layoutPageSettings &&
    measuredPages.chapterId === activeChapter.id &&
    measuredPages.contentRevision === layoutContentRevision &&
    measuredPages.pageSettings === layoutPageSettings
      ? measuredPages.count
      : null;
  const pageFrameCount = Math.max(1, Math.min(measuredPageCount ?? estimatedPages, MAX_PAGE_FRAMES));
  const pageSpreads = useMemo(() => buildPageSpreads(pageFrameCount), [pageFrameCount]);
  const clampedVisibleSpreadIndex = Math.max(0, Math.min(visibleSpreadIndex, pageSpreads.length - 1));
  const visibleSpread = pageSpreads[clampedVisibleSpreadIndex] ?? pageSpreads[0] ?? { id: "page-1", pages: [0] };
  const spreadStartPageIndex = visibleSpread.pages[0] ?? 0;
  const spreadPageCount = Math.max(1, visibleSpread.pages.length);
  const maxSpreadPageCount = pageSpreads.some((spread) => spread.pages.length > 1) ? 2 : 1;
  const visibleSpreadLabel = pageSpreadLabel(visibleSpread);
  const canGoPreviousPage = clampedVisibleSpreadIndex > 0;
  const canGoNextPage = clampedVisibleSpreadIndex < pageSpreads.length - 1;
  const pageViewportStyle = {
    "--page-scale": pageFit.scale,
    "--page-step": `${pageFit.pageStep || 1}px`,
    "--visible-page-index": spreadStartPageIndex,
    "--visible-page-offset": `calc(-${spreadStartPageIndex} * (var(--page-width) + var(--page-gap)))`,
    "--spread-width": spreadPageCount > 1 ? "calc(2 * var(--page-width) + var(--page-gap))" : "var(--page-width)",
    width: pageFit.width ? `${pageFit.width}px` : undefined,
    minHeight: pageFit.height ? `${pageFit.height}px` : undefined
  } as React.CSSProperties;

  const updateProject = useCallback((updater: (previous: ManuscriptProject) => ManuscriptProject) => {
    setProject((previous) => {
      if (!previous) {
        return previous;
      }
      return {
        ...updater(previous),
        updatedAt: new Date().toISOString()
      };
    });
  }, []);

  const toggleSidebarPanel = useCallback((panelId: SidebarPanelId) => {
    setCollapsedPanels((previous) => {
      const next = {
        ...previous,
        [panelId]: !previous[panelId]
      };
      saveSidebarCollapseState(next);
      return next;
    });
  }, []);

  const restoreEditingScrollLock = useCallback(() => {
    const stage = pageStageRef.current;
    const locked = editingScrollLockRef.current;
    if (!stage || !locked) {
      return;
    }
    if (scrollLockFrameRef.current !== null) {
      return;
    }

    scrollLockFrameRef.current = window.requestAnimationFrame(() => {
      scrollLockFrameRef.current = null;
      if (!fastEditingRef.current) {
        return;
      }

      const maxScrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
      const nextTop = Math.max(0, Math.min(locked.top, maxScrollTop));
      const needsTopRestore = Math.abs(stage.scrollTop - nextTop) > 1;
      const needsLeftRestore = Math.abs(stage.scrollLeft - locked.left) > 1;
      if (needsTopRestore) {
        stage.scrollTop = nextTop;
      }
      if (needsLeftRestore) {
        stage.scrollLeft = locked.left;
      }
      if (needsTopRestore || needsLeftRestore) {
        stage.style.setProperty("--page-scroll-top", `${stage.scrollTop}px`);
      }
    });
  }, []);

  const markTypingActivity = useCallback(() => {
    const stage = pageStageRef.current;
    if (!fastEditingRef.current) {
      editingScrollLockRef.current = stage ? { top: stage.scrollTop, left: stage.scrollLeft } : null;
      fastEditingRef.current = true;
      setFastEditing(true);
    } else if (!editingScrollLockRef.current && stage) {
      editingScrollLockRef.current = { top: stage.scrollTop, left: stage.scrollLeft };
    }
    restoreEditingScrollLock();
    if (fastEditingTimerRef.current !== null) {
      window.clearTimeout(fastEditingTimerRef.current);
    }
    fastEditingTimerRef.current = window.setTimeout(() => {
      fastEditingTimerRef.current = null;
      fastEditingRef.current = false;
      editingScrollLockRef.current = null;
      setFastEditing(false);
    }, FAST_EDITING_RESET_MS);
  }, [restoreEditingScrollLock]);

  const readLatestEditorContent = useCallback(() => pendingChapterContentRef.current ?? activeEditor?.getHTML() ?? null, [activeEditor]);

  const projectWithLatestContent = useCallback(
    (source: ManuscriptProject) => {
      const pendingContent = readLatestEditorContent();
      if (pendingContent === null) {
        return source;
      }

      return {
        ...source,
        chapters: source.chapters.map((chapter, index) => (index === 0 ? { ...chapter, content: pendingContent } : chapter))
      };
    },
    [readLatestEditorContent]
  );

  const projectWithLatestOutputState = useCallback(
    (source: ManuscriptProject) => {
      const latestProject = projectWithLatestContent(source);
      const pendingPageSettings = pendingPageSettingsRef.current;
      if (Object.keys(pendingPageSettings).length === 0) {
        return latestProject;
      }

      return normalizeDocumentProject({
        ...latestProject,
        pageSettings: {
          ...latestProject.pageSettings,
          ...pendingPageSettings
        }
      });
    },
    [projectWithLatestContent]
  );

  const flushPendingChapterContent = useCallback(() => {
    const pendingContent = readLatestEditorContent();
    if (pendingContent === null || (pendingChapterContentRef.current === null && project?.chapters[0]?.content === pendingContent)) {
      return;
    }

    if (contentCommitTimerRef.current !== null) {
      window.clearTimeout(contentCommitTimerRef.current);
      contentCommitTimerRef.current = null;
    }
    if (fastEditingTimerRef.current !== null) {
      window.clearTimeout(fastEditingTimerRef.current);
      fastEditingTimerRef.current = null;
    }
    fastEditingRef.current = false;
    editingScrollLockRef.current = null;
    setFastEditing(false);
    pendingChapterContentRef.current = null;
    updateProject((previous) => ({
      ...previous,
      chapters: previous.chapters.map((chapter, index) => (index === 0 ? { ...chapter, content: pendingContent } : chapter))
    }));
  }, [project, readLatestEditorContent, updateProject]);

  const updateActiveChapterContent = useCallback(
    (content: string) => {
      pendingChapterContentRef.current = content;
      if (contentCommitTimerRef.current !== null) {
        window.clearTimeout(contentCommitTimerRef.current);
      }

      contentCommitTimerRef.current = window.setTimeout(() => {
        const pendingContent = pendingChapterContentRef.current;
        contentCommitTimerRef.current = null;
        pendingChapterContentRef.current = null;
        if (pendingContent === null) {
          return;
        }

        updateProject((previous) => {
          const documentId = previous.chapters[0]?.id ?? crypto.randomUUID();
          return {
            ...previous,
            chapters: [
              {
                ...(previous.chapters[0] ?? { id: documentId, title: DOCUMENT_CHAPTER_TITLE }),
                id: documentId,
                title: DOCUMENT_CHAPTER_TITLE,
                content: pendingContent
              }
            ],
            activeChapterId: documentId
          };
        });
      }, CONTENT_COMMIT_DELAY_MS);
    },
    [updateProject]
  );

  const markProgrammaticPageScroll = useCallback(() => {
    programmaticPageScrollUntilRef.current = Date.now() + PAGE_PROGRAMMATIC_SCROLL_SUPPRESS_MS;
  }, []);

  const markUserPageScrollInput = useCallback(() => {
    lastUserPageScrollInputRef.current = Date.now();
  }, []);

  const alignStageToSpreadIndex = useCallback(
    (spreadIndex: number, behavior: ScrollBehavior = "auto") => {
      const stage = pageStageRef.current;
      const pageStep = pageFit.pageStep;
      if (!stage || pageStep <= 0 || pageSpreads.length === 0) {
        return;
      }

      const nextIndex = Math.max(0, Math.min(pageSpreads.length - 1, spreadIndex));
      const nextTop = nextIndex * pageStep;
      pendingScrollTopRef.current = nextTop;
      if (fastEditingRef.current) {
        editingScrollLockRef.current = { top: nextTop, left: stage.scrollLeft };
      }
      markProgrammaticPageScroll();
      if (Math.abs(stage.scrollTop - nextTop) > PAGE_SCROLL_ALIGN_TOLERANCE_PX) {
        if (behavior === "auto") {
          stage.scrollTop = nextTop;
        } else {
          stage.scrollTo({ top: nextTop, behavior });
        }
      }
      stage.style.setProperty("--page-scroll-top", `${nextTop}px`);
    },
    [markProgrammaticPageScroll, pageFit.pageStep, pageSpreads.length]
  );

  const goToSpreadIndex = useCallback(
    (spreadIndex: number) => {
      if (pageSpreads.length === 0) {
        return;
      }

      const nextIndex = Math.max(0, Math.min(pageSpreads.length - 1, spreadIndex));
      const previousIndex = visibleSpreadIndexRef.current;
      if (nextIndex === previousIndex) {
        return;
      }

      visibleSpreadIndexRef.current = nextIndex;
      setVisibleSpreadIndex(nextIndex);
      alignStageToSpreadIndex(nextIndex);
    },
    [alignStageToSpreadIndex, pageSpreads.length]
  );

  const updateVisibleSpreadFromScroll = useCallback(
    (stage: HTMLDivElement, scrollTop: number) => {
      stage.style.setProperty("--page-scroll-top", `${scrollTop}px`);
      const now = Date.now();
      if (now < programmaticPageScrollUntilRef.current || now - lastUserPageScrollInputRef.current > PAGE_USER_SCROLL_WINDOW_MS) {
        return;
      }

      const pageStep = pageFit.pageStep;
      if (pageStep <= 0) {
        return;
      }

      const nextSpreadIndex = Math.max(0, Math.min(pageSpreads.length - 1, Math.round(scrollTop / pageStep)));
      if (nextSpreadIndex === visibleSpreadIndexRef.current) {
        return;
      }

      visibleSpreadIndexRef.current = nextSpreadIndex;
      setVisibleSpreadIndex(nextSpreadIndex);
    },
    [pageFit.pageStep, pageSpreads.length]
  );

  useEffect(() => {
    const stage = pageStageRef.current;
    if (!stage) {
      return;
    }

    const flushScroll = () => {
      scrollFrameRef.current = null;
      updateVisibleSpreadFromScroll(stage, pendingScrollTopRef.current);
    };

    const handleScroll = () => {
      pendingScrollTopRef.current = stage.scrollTop;
      if (fastEditingRef.current) {
        editingScrollLockRef.current = { top: stage.scrollTop, left: stage.scrollLeft };
      }
      if (scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(flushScroll);
    };

    pendingScrollTopRef.current = stage.scrollTop;
    updateVisibleSpreadFromScroll(stage, stage.scrollTop);
    const handleWheel = () => markUserPageScrollInput();
    const handleTouchStart = () => markUserPageScrollInput();
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target === stage) {
        markUserPageScrollInput();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "PageDown" || event.key === "PageUp" || event.key === "Home" || event.key === "End" || event.key === " ") {
        markUserPageScrollInput();
      }
    };

    stage.addEventListener("scroll", handleScroll, { passive: true });
    stage.addEventListener("wheel", handleWheel, { passive: true });
    stage.addEventListener("touchstart", handleTouchStart, { passive: true });
    stage.addEventListener("pointerdown", handlePointerDown, { passive: true });
    stage.addEventListener("keydown", handleKeyDown);
    return () => {
      stage.removeEventListener("scroll", handleScroll);
      stage.removeEventListener("wheel", handleWheel);
      stage.removeEventListener("touchstart", handleTouchStart);
      stage.removeEventListener("pointerdown", handlePointerDown);
      stage.removeEventListener("keydown", handleKeyDown);
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [markUserPageScrollInput, updateVisibleSpreadFromScroll]);

  useEffect(() => {
    const nextSpreadIndex = Math.max(0, Math.min(visibleSpreadIndexRef.current, pageSpreads.length - 1));
    if (nextSpreadIndex !== visibleSpreadIndexRef.current) {
      visibleSpreadIndexRef.current = nextSpreadIndex;
      setVisibleSpreadIndex(nextSpreadIndex);
    }
  }, [pageSpreads.length]);

  useLayoutEffect(() => {
    if (pageFit.pageStep <= 0 || pageSpreads.length === 0) {
      return;
    }

    if (fastEditingRef.current) {
      restoreEditingScrollLock();
      return;
    }

    const nextIndex = Math.max(0, Math.min(visibleSpreadIndexRef.current, pageSpreads.length - 1));
    visibleSpreadIndexRef.current = nextIndex;
    alignStageToSpreadIndex(nextIndex);
  }, [alignStageToSpreadIndex, fastEditing, pageFit.pageStep, pageSpreads.length, restoreEditingScrollLock]);

  useEffect(() => {
    const handlePageKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTextInputTarget(event.target)) {
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        goToSpreadIndex(visibleSpreadIndexRef.current + 1);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToSpreadIndex(visibleSpreadIndexRef.current - 1);
      }
    };

    window.addEventListener("keydown", handlePageKey);
    return () => window.removeEventListener("keydown", handlePageKey);
  }, [goToSpreadIndex]);

  useEffect(() => {
    if (!activeChapter || !layoutPageSettings || fastEditing) {
      return;
    }

    const handle = window.requestAnimationFrame(() => {
      const stage = pageStageRef.current;
      const prose = stage?.querySelector<HTMLElement>(".paged-editor-layer .manuscript-prose");
      const firstFrame = stage?.querySelector<HTMLElement>(".page-frame");
      if (!prose || !firstFrame) {
        return;
      }

      const pageGap = stage ? readCssLengthPx(stage, "--page-gap") : 0;
      const pagePitch = firstFrame.offsetWidth + pageGap;
      const firstFrameRect = firstFrame.getBoundingClientRect();
      const visualPagePitch = pagePitch * pageFit.scale;
      if (pagePitch <= 0 || visualPagePitch <= 0) {
        return;
      }

      const measuredContentPages = measureOccupiedPreviewPages(prose, firstFrameRect.left - spreadStartPageIndex * visualPagePitch, visualPagePitch);
      const actualPages = measuredContentPages ?? Math.ceil((prose.scrollWidth + 1) / pagePitch);
      const nextCount = Math.max(1, Math.min(actualPages, MAX_PAGE_FRAMES));
      const titleCount = nextCount;
      const nextTitles = Array.from({ length: titleCount }, () => "");
      const nextHeadingPageNumbers: number[] = [];
      const firstFrameLeft = firstFrameRect.left - spreadStartPageIndex * visualPagePitch;
      prose.querySelectorAll<HTMLElement>("h1").forEach((heading) => {
        if (heading.closest("[data-type='table-of-contents']")) {
          return;
        }

        const pageIndex = Math.max(0, Math.min(titleCount - 1, Math.floor((heading.getBoundingClientRect().left - firstFrameLeft + 2) / visualPagePitch)));
        nextHeadingPageNumbers.push(pageIndex + 1);
        const title = heading.textContent?.trim();
        if (!title) {
          return;
        }

        for (let index = pageIndex; index < nextTitles.length; index += 1) {
          nextTitles[index] = title;
        }
      });
      setPageSectionTitles((previous) => (sameStringList(previous, nextTitles) ? previous : nextTitles));
      setHeadingPageNumbers((previous) => (sameNumberList(previous, nextHeadingPageNumbers) ? previous : nextHeadingPageNumbers));

      if (Number.isFinite(nextCount) && nextCount !== measuredPageCount) {
        setMeasuredPages({
          chapterId: activeChapter.id,
          contentRevision: layoutContentRevision,
          pageSettings: layoutPageSettings,
          count: nextCount
        });
      }
    });

    return () => window.cancelAnimationFrame(handle);
  }, [activeChapter, fastEditing, layoutChapterContent, layoutContentRevision, layoutPageSettings, measuredPageCount, pageFit.scale, pageFrameCount, spreadStartPageIndex]);

  useEffect(() => {
    const stage = pageStageRef.current;
    if (!stage) {
      return;
    }

    let frameHandle: number | null = null;
    const updatePageFit = () => {
      if (frameHandle !== null) {
        return;
      }

      frameHandle = window.requestAnimationFrame(() => {
        frameHandle = null;
        const frame = stage.querySelector<HTMLElement>(".page-frame");
        if (!frame) {
          return;
        }

        const stageRect = stage.getBoundingClientRect();
        const pageWidth = frame.offsetWidth;
        const pageHeight = frame.offsetHeight;
        const pageGap = readCssLengthPx(stage, "--page-gap");
        if (pageWidth <= 0 || pageHeight <= 0) {
          return;
        }

        const maxSpreadWidth = pageWidth * maxSpreadPageCount + pageGap * Math.max(0, maxSpreadPageCount - 1);
        const visibleSpreadWidth = pageWidth * spreadPageCount + pageGap * Math.max(0, spreadPageCount - 1);
        const availableWidth = Math.max(160, stageRect.width - 20);
        const availableHeight = Math.max(160, stageRect.height - 20);
        const scale = Math.max(0.32, Math.min(1, availableWidth / maxSpreadWidth, availableHeight / pageHeight));
        const scaledPageHeight = pageHeight * scale;
        const scaledPageGap = pageGap * scale;
        const pageStep = Math.max(1, Number((scaledPageHeight + scaledPageGap).toFixed(4)));
        const nextFit = {
          scale: Number(scale.toFixed(4)),
          width: Math.ceil(visibleSpreadWidth * scale),
          height: Math.ceil(pageSpreads.length * pageStep),
          pageStep
        };
        setPageFit((previous) =>
          previous.scale === nextFit.scale && previous.width === nextFit.width && previous.height === nextFit.height && previous.pageStep === nextFit.pageStep
            ? previous
            : nextFit
        );
      });
    };

    const resizeObserver = new ResizeObserver(updatePageFit);
    const frame = stage.querySelector<HTMLElement>(".page-frame");
    resizeObserver.observe(stage);
    if (frame) {
      resizeObserver.observe(frame);
    }
    updatePageFit();
    window.addEventListener("resize", updatePageFit);
    return () => {
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePageFit);
    };
  }, [maxSpreadPageCount, pageSpreads.length, spreadPageCount]);

  useEffect(() => {
    if (!activeEditor || !tocSettingsForSync || fastEditing) {
      return;
    }

    syncTableOfContentsNodes(activeEditor, tocSettingsForSync, tocEntries);
  }, [activeEditor, fastEditing, tocEntries, tocSettingsForSync]);

  if (!project || !activeChapter) {
    return (
      <main className="app-loading">
        <div className="loading-mark" />
        <p>原稿を開いています</p>
      </main>
    );
  }

  const stylePageSettings = project.pageSettings;
  const imageLayout = imageLayoutVarsForPage(stylePageSettings);
  const pageStyle = {
    "--page-width": `${stylePageSettings.pageWidthMm}mm`,
    "--page-height": `${stylePageSettings.pageHeightMm}mm`,
    "--page-aspect": `${stylePageSettings.pageWidthMm} / ${stylePageSettings.pageHeightMm}`,
    "--margin-top": `${stylePageSettings.marginTopMm}mm`,
    "--margin-bottom": `${stylePageSettings.marginBottomMm}mm`,
    "--margin-left": `${stylePageSettings.marginLeftMm}mm`,
    "--margin-right": `${stylePageSettings.marginRightMm}mm`,
    "--manuscript-font-family": MANUSCRIPT_FONTS[stylePageSettings.fontFamily ?? "noto-serif-jp"].css,
    "--manuscript-font-size": `${stylePageSettings.fontSizePt}pt`,
    "--ruby-font-size": `${stylePageSettings.rubySizePt}pt`,
    "--line-height": stylePageSettings.lineHeight,
    "--paragraph-spacing": `${stylePageSettings.paragraphSpacingMm}mm`,
    "--image-max-height": `${stylePageSettings.imageMaxHeightMm}mm`,
    "--image-block-margin": imageLayout.blockMargin,
    "--image-content-height-offset": imageLayout.contentHeightOffset,
    "--fragmentation-guard": imageLayout.fragmentationGuard,
    "--image-page-height-limit": imageLayout.pageHeightLimit,
    "--image-fit-padding": imageLayout.fitPadding,
    "--page-gap": `${PAGE_GAP_MM}mm`,
    "--content-width": "calc(var(--page-width) - var(--margin-left) - var(--margin-right))",
    "--content-height": "calc(var(--page-height) - var(--margin-top) - var(--margin-bottom))",
    "--column-gap": "calc(var(--margin-left) + var(--margin-right) + var(--page-gap))",
    "--paged-track-width": `calc(${pageFrameCount} * var(--page-width) + ${pageFrameCount - 1} * var(--page-gap))`,
    "--paged-content-width": `calc(${pageFrameCount} * (var(--page-width) - var(--margin-left) - var(--margin-right)) + ${pageFrameCount - 1} * (var(--margin-left) + var(--margin-right) + var(--page-gap)))`
  } as React.CSSProperties;

  const jumpToHeading = (index: number) => {
    setMobileTab("draft");
    window.requestAnimationFrame(() => {
      const stage = pageStageRef.current;
      if (!stage) {
        return;
      }

      const targetPageIndex = Math.max(0, Math.min(pageFrameCount - 1, (headingPageNumbers[index] ?? 1) - 1));
      const targetSpreadIndex = findSpreadIndexForPage(pageSpreads, targetPageIndex);
      goToSpreadIndex(targetSpreadIndex);
    });
  };

  const handlePreset = (preset: PagePresetId) => {
    updateProject((previous) => ({
      ...previous,
      pageSettings: applyPreset(previous.pageSettings, preset)
    }));
  };

  // フォント・余白などのページ設定変更は 300ms debounceでまとめて反映する
  // （即時適用すると入力のたびに全体のコンポーネントが再計算されて重くなるため）
  const updatePageSetting = (key: keyof PageSettings, value: PageSettings[keyof PageSettings]) => {
    // 変更内容を一時保持（複数の設定をまとめて扱える）
    pendingPageSettingsRef.current = { ...pendingPageSettingsRef.current, [key]: value };

    if (pageSettingTimerRef.current !== null) {
      window.clearTimeout(pageSettingTimerRef.current);
    }

    pageSettingTimerRef.current = window.setTimeout(() => {
      const pending = pendingPageSettingsRef.current;
      pendingPageSettingsRef.current = {};
      pageSettingTimerRef.current = null;
      updateProject((previous) => ({
        ...previous,
        pageSettings: { ...previous.pageSettings, ...pending }
      }));
    }, 300);
  };

  const applyPasteLayoutHints = (hints: PasteLayoutHints) => {
    updateProject((previous) => ({
      ...previous,
      pageSettings: {
        ...previous.pageSettings,
        ...(hints.fontSizePt ? { fontSizePt: hints.fontSizePt } : {}),
        ...(hints.lineHeight ? { lineHeight: hints.lineHeight } : {}),
        ...(hints.paragraphSpacingMm !== undefined ? { paragraphSpacingMm: hints.paragraphSpacingMm } : {})
      }
    }));
    setStatusText("Google Docsの文字設定を反映");
  };

  const updateTocSetting = (key: keyof TocSettings, value: TocSettings[keyof TocSettings]) => {
    if (!project) {
      return;
    }

    const nextSettings = {
      ...project.tocSettings,
      [key]: value
    };

    updateProject((previous) => ({
      ...previous,
      tocSettings: {
        ...previous.tocSettings,
        [key]: value
      }
    }));
    if (activeEditor) {
      const changed = syncTableOfContentsNodes(activeEditor, nextSettings, tocEntries);
      if (changed) {
        setStatusText("目次設定を反映しました");
      }
    }
  };

  const insertTableOfContents = () => {
    if (!activeEditor) {
      window.alert("本文エディタの準備ができてから目次を挿入してください。");
      return;
    }

    const insertPosition = activeEditor.state.selection.to;
    activeEditor
      .chain()
      .focus()
      .insertContentAt(insertPosition, [
        {
          type: "tableOfContents",
          attrs: {
            ...tableOfContentsAttrs(project.tocSettings, tocEntries),
            pageBreakBefore: shouldStartInsertedBlockOnNewPage(activeEditor, insertPosition)
          }
        },
        {
          type: "paragraph"
        }
      ])
      .run();
    setMobileTab("draft");
    setStatusText("目次を挿入しました");
  };

  const refreshTableOfContents = () => {
    if (!activeEditor) {
      return;
    }

    const changed = syncTableOfContentsNodes(activeEditor, project.tocSettings, tocEntries);
    setStatusText(changed ? "目次を更新しました" : "目次は最新です");
  };

  const saveDriveSettingsFromDraft = () => {
    const saved = saveGoogleDriveSettings(driveSettingsDraft);
    setDriveSettingsDraft(saved);
    setDriveClient(null);
    setStatusText("Google Drive設定を保存しました");
  };

  const clearDriveSettingsFromDraft = () => {
    clearGoogleDriveSettings();
    resetGoogleDriveClient();
    setDriveClient(null);
    setDriveSettingsDraft(loadGoogleDriveSettings());
    setStatusText("Google Drive設定をクリアしました");
  };

  const ensureDriveClient = async () => {
    if (!isDriveConfigured()) {
      throw new Error(googleDriveSetupMessage());
    }

    const client = driveClient ?? (await connectGoogleDrive());
    setDriveClient(client);
    return client;
  };

  const updateDriveFolder = (folder: DriveFolder | null) => {
    updateProject((previous) => {
      const nextDrive = { ...(previous.drive ?? {}) };
      if (folder) {
        nextDrive.folderId = folder.id;
        nextDrive.folderName = folder.name;
      } else {
        delete nextDrive.folderId;
        delete nextDrive.folderName;
      }

      return {
        ...previous,
        drive: nextDrive
      };
    });
    setStatusText(folder ? `Drive保存先: ${folder.name}` : "Drive保存先: マイドライブ直下");
  };

  const loadDriveFolders = async () => {
    try {
      const client = await ensureDriveClient();
      const folders = await client.listFolders();
      setDriveFolders(folders);
      setStatusText("Driveフォルダ一覧を取得しました");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Driveフォルダ一覧を取得できませんでした。");
    }
  };

  const selectDriveFolder = (folderId: string) => {
    if (!folderId) {
      updateDriveFolder(null);
      return;
    }

    const folder = driveFolders.find((candidate) => candidate.id === folderId);
    updateDriveFolder(folder ?? { id: folderId, name: "選択フォルダ" });
  };

  const createDriveFolder = async () => {
    const folderName = window.prompt("Google Driveに作る保存先フォルダ名", `${project?.title || "Umbrella Parade"} 原稿`);
    if (!folderName?.trim()) {
      return;
    }

    try {
      const client = await ensureDriveClient();
      const folder = await client.createFolder(folderName);
      setDriveFolders((previous) => [folder, ...previous.filter((candidate) => candidate.id !== folder.id)]);
      updateDriveFolder(folder);
      setStatusText(`Drive保存先を作成: ${folder.name}`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Driveフォルダを作成できませんでした。");
    }
  };

  const exportJson = async () => {
    try {
      const latestProject = projectWithLatestContent(project);
      await exportProjectJson(latestProject);
      flushPendingChapterContent();
      setStatusText("JSONを書き出し");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "JSONを書き出せませんでした。");
    }
  };

  const manualSave = async () => {
    try {
      const latestProject = projectWithLatestContent(project);
      await saveProjectToBrowser(latestProject);
      flushPendingChapterContent();
      setStatusText(`ブラウザ保存 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`);
    } catch (error) {
      setStatusText("ブラウザ保存に失敗");
      window.alert(error instanceof Error ? error.message : "ブラウザ保存に失敗しました。");
    }
  };

  const importJson = async (file: File) => {
    try {
      const imported = await readJsonFile(file);
      if (contentCommitTimerRef.current !== null) {
        window.clearTimeout(contentCommitTimerRef.current);
        contentCommitTimerRef.current = null;
      }
      if (fastEditingTimerRef.current !== null) {
        window.clearTimeout(fastEditingTimerRef.current);
        fastEditingTimerRef.current = null;
      }
      setFastEditing(false);
      pendingChapterContentRef.current = null;
      setProject(normalizeDocumentProject({ ...imported, updatedAt: new Date().toISOString() }));
      setStatusText("JSONを読み込み");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "JSONを読み込めませんでした。");
    }
  };

  const saveToDrive = async () => {
    try {
      if (!isDriveConfigured()) {
        window.alert(googleDriveSetupMessage());
        return;
      }

      const latestProject = projectWithLatestContent(project);
      const client = await ensureDriveClient();
      const result = await client.saveProject(latestProject, latestProject.drive?.folderId);
      const savedFolderId = result.folderId ?? latestProject.drive?.folderId ?? "";
      const savedFolderName = savedFolderId ? latestProject.drive?.folderName : undefined;
      flushPendingChapterContent();
      updateProject((previous) => ({
        ...previous,
        drive: {
          fileId: result.fileId,
          lastSavedAt: result.savedAt,
          ...(savedFolderId ? { folderId: savedFolderId } : {}),
          ...(savedFolderName ? { folderName: savedFolderName } : {})
        }
      }));
      setStatusText(savedFolderName ? `Google Drive保存: ${savedFolderName}` : "Google Drive保存");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Google Drive保存に失敗しました。");
    }
  };

  const downloadPdfResult = (result: RasterPdfBuildResult) => {
    downloadBlob(new Blob([uint8ArrayToArrayBuffer(result.bytes)], { type: "application/pdf" }), result.fileName);
    setStatusText(`PDFを書き出しました（${result.pageCount}ページ）`);
  };

  const exportPdf = async () => {
    let exportRoot: HTMLElement | null = null;
    try {
      setStatusText("現在の原稿をPDFとして書き出し中");
      const latestProject = projectWithLatestOutputState(project);
      const latestChapter = latestProject.chapters[0];
      if (!latestChapter) {
        window.alert("本文がありません。");
        return;
      }

      const baseSnapshot: PdfExportSnapshot = {
        project: latestProject,
        chapter: latestChapter,
        sectionTitles: [],
        pageCount: 1
      };
      const measuredLayout = await measurePdfExportLayout(baseSnapshot);
      const exportPageCount = measuredLayout.pageCount;

      const snapshot: PdfExportSnapshot = {
        project: latestProject,
        chapter: latestChapter,
        sectionTitles: measuredLayout.sectionTitles,
        pageCount: exportPageCount
      };
      exportRoot = createPdfExportDom(snapshot);
      document.body.append(exportRoot);
      await nextAnimationFrame();
      await nextAnimationFrame();

      const result = await buildRasterPdfFromDom(exportRoot, snapshot, (pageIndex, totalPages) => {
        setStatusText(`PDF書き出し中: ${pageIndex + 1}/${totalPages}ページ`);
      });
      if (result.pageCount !== exportPageCount) {
        throw new Error(`原稿ツールとPDFのページ数が一致しません。原稿: ${exportPageCount}ページ / PDF: ${result.pageCount}ページ`);
      }

      flushPendingChapterContent();
      setPageSectionTitles((previous) => (sameStringList(previous, measuredLayout.sectionTitles) ? previous : measuredLayout.sectionTitles));
      if (latestChapter.content === layoutChapterContent && latestProject.pageSettings === layoutPageSettings) {
        setMeasuredPages({
          chapterId: latestChapter.id,
          contentRevision: layoutContentRevision,
          pageSettings: latestProject.pageSettings,
          count: exportPageCount
        });
      }
      downloadPdfResult(result);
    } catch (error) {
      setStatusText("PDF書き出しに失敗");
      window.console.error(error);
      window.alert(error instanceof Error ? error.message : "PDFを書き出せませんでした。");
    } finally {
      exportRoot?.remove();
    }
  };

  const exportDocx = async () => {
    try {
      const latestProject = projectWithLatestContent(project);
      await exportProjectDocx(latestProject);
      flushPendingChapterContent();
      setStatusText("DOCXを書き出し");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "DOCXを書き出せませんでした。");
    }
  };

  const exportEpub = async () => {
    try {
      const latestProject = projectWithLatestContent(project);
      await exportProjectEpub(latestProject);
      flushPendingChapterContent();
      setStatusText("EPUBを書き出し");
    } catch (error) {
      window.console.error(error);
      window.alert(error instanceof Error ? error.message : "EPUBを書き出せませんでした。");
    }
  };

  const readQrDraft = (draft: QrDraft): Omit<QrLink, "id"> | null => {
    const name = draft.name.trim();
    const url = draft.url.trim();
    const description = draft.description.trim();
    const category = draft.category.trim() || "公式サイト";
    const template = getQrCardTemplateId(draft.template);

    if (!name || !url) {
      window.alert("太字タイトルとQRのURLを入力してください。");
      return null;
    }

    if (!isValidUrl(url)) {
      window.alert("http または https のURLを入力してください。");
      return null;
    }

    return { name, url, description, category, template };
  };

  const addQrLink = (draft: QrDraft, mode: "save" | "insert" = "save") => {
    const values = readQrDraft(draft);
    if (!values) {
      return false;
    }

    const link: QrLink = {
      id: crypto.randomUUID(),
      ...values
    };
    updateProject((previous) => ({
      ...previous,
      qrLinks: [...previous.qrLinks, link]
    }));

    if (mode === "insert") {
      void insertQrLink(link);
    }
    return true;
  };

  const insertQrLink = async (link: QrLink) => {
    if (!activeEditor) {
      window.alert("本文エディタの準備ができてから挿入してください。");
      return;
    }
    const template = getQrCardTemplateId(link.template);
    const src = await QRCode.toDataURL(link.url, {
      margin: 1,
      width: 420,
      color: { dark: QR_CARD_TEMPLATES[template].qrDark, light: "#ffffff" }
    });
    const insertPosition = activeEditor.state.selection.to;
    activeEditor
      .chain()
      .focus()
      .insertContentAt(insertPosition, [
        {
          type: "qrCard",
          attrs: {
            instanceId: crypto.randomUUID(),
            url: link.url,
            title: link.name,
            description: link.description,
            src,
            template,
            label: link.category || "記録室リンク"
          }
        },
        {
          type: "paragraph"
        }
      ])
      .run();
    setMobileTab("draft");
  };

  const syncQrCards = async (previousLink: QrLink, nextLink: QrLink) => {
    if (!activeEditor) {
      return;
    }

    const template = getQrCardTemplateId(nextLink.template);
    const src = await QRCode.toDataURL(nextLink.url, {
      margin: 1,
      width: 420,
      color: { dark: QR_CARD_TEMPLATES[template].qrDark, light: "#ffffff" }
    });

    activeEditor
      .chain()
      .command(({ state, tr }) => {
        let visited = false;
        state.doc.descendants((node, position) => {
          if (node.type.name !== "qrCard") {
            return;
          }

          const sameUrl = node.attrs.url === previousLink.url;
          const sameTitle = !previousLink.name || node.attrs.title === previousLink.name;
          if (sameUrl && sameTitle) {
            tr.setNodeMarkup(position, undefined, {
              ...node.attrs,
              url: nextLink.url,
              title: nextLink.name,
              description: nextLink.description,
              src,
              template,
              label: nextLink.category || "記録室リンク"
            });
          }
          visited = true;
        });
        return visited;
      })
      .run();
  };

  const updateQrLink = async (id: string, draft: QrDraft): Promise<boolean> => {
    const values = readQrDraft(draft);
    if (!values) {
      return false;
    }

    const previousLink = project.qrLinks.find((item) => item.id === id);
    if (!previousLink) {
      return false;
    }

    const nextLink: QrLink = { id, ...values };
    updateProject((previous) => ({
      ...previous,
      qrLinks: previous.qrLinks.map((item) => (item.id === id ? nextLink : item))
    }));

    await syncQrCards(previousLink, nextLink);
    return true;
  };

  const updateQrLinkTemplate = async (id: string, template: QrCardTemplateId) => {
    const link = project.qrLinks.find((item) => item.id === id);
    if (!link) {
      return;
    }

    await updateQrLink(id, {
      name: link.name,
      url: link.url,
      description: link.description,
      category: link.category,
      template
    });
  };

  const openQrLibrary = () => {
    setMobileTab("check");
    setStatusText("QRリンクパネルを開きました");
    window.requestAnimationFrame(() => {
      qrPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      qrPanelRef.current?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")?.focus({ preventScroll: true });
    });
  };

  const resetProject = () => {
    if (!window.confirm("新規原稿を作成しますか？現在のブラウザ保存は上書きされます。")) {
      return;
    }
    if (contentCommitTimerRef.current !== null) {
      window.clearTimeout(contentCommitTimerRef.current);
      contentCommitTimerRef.current = null;
    }
    if (fastEditingTimerRef.current !== null) {
      window.clearTimeout(fastEditingTimerRef.current);
      fastEditingTimerRef.current = null;
    }
    setFastEditing(false);
    pendingChapterContentRef.current = null;
    setProject(normalizeDocumentProject(createDefaultProject()));
    setStatusText("新規原稿");
  };

  return (
    <main className="app-shell" style={pageStyle}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">UP</span>
          <div>
            <p className="eyebrow">Umbrella Parade</p>
            <h1>原稿制作ツール</h1>
          </div>
        </div>
        <div className="topbar-editor-tools">
          <TiptapToolbar editor={activeEditor} onOpenQrLibrary={openQrLibrary} />
        </div>
        <div className="topbar-actions">
          <span className="save-state">{statusText}</span>
          <button className="command-button" type="button" onClick={manualSave} title="保存">
            <Save size={17} />
            保存
          </button>
          <button className="command-button" type="button" onClick={() => importInputRef.current?.click()} title="JSON読み込み">
            <FolderOpen size={17} />
            読込
          </button>
          <button className="command-button" type="button" onClick={exportJson} title="JSON書き出し">
            <FileJson size={17} />
            JSON
          </button>
          <button className="command-button" type="button" onClick={exportPdf} title="PDF書き出し">
            <FileDown size={17} />
            PDF
          </button>
          <button className="command-button" type="button" onClick={exportDocx} title="DOCX出力">
            <FileText size={17} />
            DOCX
          </button>
          <button className="command-button" type="button" onClick={exportEpub} title="EPUB出力">
            <BookOpen size={17} />
            EPUB
          </button>
          <button className="command-button command-button-strong" type="button" onClick={saveToDrive} title="Google Drive保存">
            <Cloud size={17} />
            Drive
          </button>
        </div>
        <input
          ref={importInputRef}
          className="hidden"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importJson(file);
            }
            event.currentTarget.value = "";
          }}
        />
      </header>

      <nav className="mobile-tabs" aria-label="スマホ表示タブ">
        {(Object.keys(tabLabels) as MobileTab[]).map((tab) => (
          <button key={tab} className={mobileTab === tab ? "is-active" : ""} type="button" onClick={() => setMobileTab(tab)}>
            {tabLabels[tab]}
          </button>
        ))}
      </nav>

      <div className="workspace-grid">
        <aside className={`left-rail mobile-panel ${mobileTab === "chapters" ? "is-mobile-active" : ""}`}>
          <TableOfContentsPanel
            entries={tocEntries}
            settings={project.tocSettings}
            collapsed={collapsedPanels.toc}
            onToggle={() => toggleSidebarPanel("toc")}
            onSettingChange={updateTocSetting}
            onInsert={insertTableOfContents}
            onRefresh={refreshTableOfContents}
            onJump={jumpToHeading}
          />
          <ProjectPanel
            project={project}
            collapsed={collapsedPanels.project}
            onToggle={() => toggleSidebarPanel("project")}
            onProjectChange={updateProject}
            onPreset={handlePreset}
            onPageChange={updatePageSetting}
            onReset={resetProject}
          />
        </aside>

        <section className={`editor-column mobile-panel ${mobileTab === "draft" ? "is-mobile-active" : ""}`} aria-label="本文編集">
          <div className="chapter-heading-row">
            <div className="document-title-label">
              <FileText size={16} />
            <span>{project.title}</span>
          </div>
          <span className="chapter-meta">{characterCount.toLocaleString("ja-JP")}字</span>
        </div>
        <div ref={pageStageRef} className={`page-stage ${fastEditing ? "is-fast-editing" : ""}`}>
          <div className="page-viewport" style={pageViewportStyle}>
            <div
              className={`paged-document ${estimatedPages > 1 ? "is-long-manuscript" : ""} ${spreadPageCount > 1 ? "is-spread" : "is-single-page"}`}
              data-estimated-pages={estimatedPages}
              data-rendered-pages={pageFrameCount}
              data-visible-page={spreadStartPageIndex + 1}
              data-visible-spread={clampedVisibleSpreadIndex + 1}
            >
              <div className="page-frame-track" aria-hidden="true">
                {visibleSpread.pages.map((pageIndex) => (
                  <section key={pageIndex} className="page-frame" data-page-number={pageIndex + 1}>
                    <header className="page-frame-header">
                      {pageSectionTitles[pageIndex] ? <span>{pageSectionTitles[pageIndex]}</span> : null}
                    </header>
                    {project.pageSettings.showBleedGuide ? <div className="page-bleed-guide" /> : null}
                    {project.pageSettings.showSafeArea ? <div className="page-safe-guide" /> : null}
                    <footer className="page-frame-footer">
                      {project.pageSettings.showPageNumber ? <span>{pageIndex + 1}</span> : null}
                    </footer>
                  </section>
                ))}
              </div>
              <div className="paged-editor-layer">
                <TiptapEditor
                  key={activeChapter.id}
                  content={activeChapter.content}
                  onChange={updateActiveChapterContent}
                  onTypingActivity={markTypingActivity}
                  onPasteLayoutHints={applyPasteLayoutHints}
                  onReady={setActiveEditor}
                />
              </div>
            </div>
            <div className="page-scroll-track" aria-hidden="true">
              {pageSpreads.map((spread) => (
                <div key={spread.id} className="page-scroll-slot" />
              ))}
            </div>
          </div>
          </div>
          <nav className="page-navigation" aria-label="ページ送り">
            <div className="page-stepper">
              <button type="button" onClick={() => goToSpreadIndex(clampedVisibleSpreadIndex - 1)} disabled={!canGoPreviousPage} aria-label="前のページへ">
                <ChevronLeft size={16} />
                <Minus size={14} />
              </button>
              <span className="page-stepper-current">{visibleSpreadLabel} / {pageFrameCount}頁</span>
              <button type="button" onClick={() => goToSpreadIndex(clampedVisibleSpreadIndex + 1)} disabled={!canGoNextPage} aria-label="次のページへ">
                <Plus size={14} />
                <ChevronRight size={16} />
              </button>
            </div>
            <label className="page-jump-control">
              <span>ページ移動</span>
              <select value={clampedVisibleSpreadIndex} onChange={(event) => goToSpreadIndex(Number(event.target.value))} aria-label="移動するページ">
                {pageSpreads.map((spread, index) => (
                  <option key={spread.id} value={index}>
                    {pageSpreadLabel(spread)}
                  </option>
                ))}
              </select>
            </label>
          </nav>
        </section>

        <aside className={`right-rail mobile-panel ${mobileTab === "check" ? "is-mobile-active" : ""}`}>
          <QrLibraryPanel
            panelRef={qrPanelRef}
            links={project.qrLinks}
            collapsed={collapsedPanels.qr}
            onToggle={() => toggleSidebarPanel("qr")}
            onAdd={addQrLink}
            onInsert={insertQrLink}
            onUpdate={updateQrLink}
            onTemplateChange={updateQrLinkTemplate}
            onDelete={(id) => updateProject((previous) => ({ ...previous, qrLinks: previous.qrLinks.filter((link) => link.id !== id) }))}
          />
          <DriveSettingsPanel
            settings={driveSettingsDraft}
            isConfigured={isDriveConfigured()}
            hasBundledSettings={bundledDriveSettings}
            currentFolderId={project.drive?.folderId ?? ""}
            currentFolderName={project.drive?.folderName ?? ""}
            folders={driveFolders}
            collapsed={collapsedPanels.drive}
            onToggle={() => toggleSidebarPanel("drive")}
            onChange={setDriveSettingsDraft}
            onSave={saveDriveSettingsFromDraft}
            onClear={clearDriveSettingsFromDraft}
            onLoadFolders={() => void loadDriveFolders()}
            onSelectFolder={selectDriveFolder}
            onCreateFolder={() => void createDriveFolder()}
          />
          <CheckPanel checks={checks} characterCount={characterCount} estimatedPages={estimatedPages} collapsed={collapsedPanels.check} onToggle={() => toggleSidebarPanel("check")} />
        </aside>
      </div>
    </main>
  );
}

function CollapsibleToolPanel({
  title,
  className = "",
  collapsed,
  onToggle,
  badge,
  titleAction,
  panelRef,
  children
}: {
  title: string;
  className?: string;
  collapsed: boolean;
  onToggle: () => void;
  badge?: ReactNode;
  titleAction?: ReactNode;
  panelRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  return (
    <section ref={panelRef} className={`tool-panel ${className} ${collapsed ? "is-collapsed" : ""}`.trim()}>
      <div className="panel-title-row">
        <h2>{title}</h2>
        <div className="panel-title-controls">
          {badge}
          {titleAction}
          <button
            className="panel-collapse-button icon-button small"
            type="button"
            aria-expanded={!collapsed}
            title={collapsed ? "開く" : "折りたたむ"}
            aria-label={`${title}を${collapsed ? "開く" : "折りたたむ"}`}
            onClick={onToggle}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>
      {collapsed ? null : <div className="panel-collapse-content">{children}</div>}
    </section>
  );
}

function ProjectPanel({
  project,
  collapsed,
  onToggle,
  onProjectChange,
  onPreset,
  onPageChange,
  onReset
}: {
  project: ManuscriptProject;
  collapsed: boolean;
  onToggle: () => void;
  onProjectChange: (updater: (previous: ManuscriptProject) => ManuscriptProject) => void;
  onPreset: (preset: PagePresetId) => void;
  onPageChange: (key: keyof PageSettings, value: PageSettings[keyof PageSettings]) => void;
  onReset: () => void;
}) {
  const settings = project.pageSettings;
  const fontSizeMm = settings.fontSizePt * 0.352778;
  const lineAdvanceMm = Math.max(0.1, fontSizeMm * settings.lineHeight);
  const textWidthMm = Math.max(0, settings.pageWidthMm - settings.marginLeftMm - settings.marginRightMm);
  const textHeightMm = Math.max(0, settings.pageHeightMm - settings.marginTopMm - settings.marginBottomMm);
  const charsPerLine = Math.max(1, Math.floor(textWidthMm / Math.max(0.1, fontSizeMm)));
  const linesPerPage = Math.max(1, Math.floor(textHeightMm / lineAdvanceMm));
  const charsPerPage = charsPerLine * linesPerPage;
  const updateProjectText = (key: "title" | "subtitle" | "author", value: string) => {
    onProjectChange((previous) => ({ ...previous, [key]: value }));
  };

  return (
    <CollapsibleToolPanel
      title="プロジェクト"
      collapsed={collapsed}
      onToggle={onToggle}
      titleAction={
        <button className="icon-button" type="button" title="新規" aria-label="新規" onClick={onReset}>
          <Plus size={17} />
        </button>
      }
    >
      <label className="field">
        <span>作品名</span>
        <input value={project.title} onChange={(event) => updateProjectText("title", event.target.value)} />
      </label>
      <label className="field">
        <span>サブタイトル</span>
        <input value={project.subtitle} onChange={(event) => updateProjectText("subtitle", event.target.value)} />
      </label>
      <label className="field">
        <span>著者</span>
        <input value={project.author} onChange={(event) => updateProjectText("author", event.target.value)} />
      </label>
      <label className="field">
        <span>本文フォント</span>
        <select value={settings.fontFamily} onChange={(event) => onPageChange("fontFamily", event.target.value as ManuscriptFontId)}>
          {(Object.entries(MANUSCRIPT_FONTS) as Array<[ManuscriptFontId, (typeof MANUSCRIPT_FONTS)[ManuscriptFontId]]>).map(([fontId, font]) => (
            <option key={fontId} value={fontId}>{font.label}</option>
          ))}
        </select>
      </label>

      <div className="segmented" aria-label="ページ設定プリセット">
        {(Object.entries(PAGE_PRESETS) as Array<[PagePresetId, (typeof PAGE_PRESETS)[PagePresetId]]>).map(([preset, data]) => (
          <button key={preset} className={settings.preset === preset ? "is-active" : ""} type="button" onClick={() => onPreset(preset)}>
            {data.label}
          </button>
        ))}
      </div>

      <div className="number-grid">
        <NumberField label="幅mm" value={settings.pageWidthMm} onChange={(value) => onPageChange("pageWidthMm", value)} />
        <NumberField label="高さmm" value={settings.pageHeightMm} onChange={(value) => onPageChange("pageHeightMm", value)} />
        <NumberField label="上余白" value={settings.marginTopMm} onChange={(value) => onPageChange("marginTopMm", value)} />
        <NumberField label="下余白" value={settings.marginBottomMm} onChange={(value) => onPageChange("marginBottomMm", value)} />
        <NumberField label="左余白" value={settings.marginLeftMm} onChange={(value) => onPageChange("marginLeftMm", value)} />
        <NumberField label="右余白" value={settings.marginRightMm} onChange={(value) => onPageChange("marginRightMm", value)} />
        <NumberField label="本文pt" value={settings.fontSizePt} step={0.1} onChange={(value) => onPageChange("fontSizePt", value)} />
        <NumberField label="ルビpt" value={settings.rubySizePt} step={0.1} onChange={(value) => onPageChange("rubySizePt", value)} />
        <NumberField label="行間倍率" value={settings.lineHeight} step={0.01} onChange={(value) => onPageChange("lineHeight", value)} />
        <NumberField label="改行後mm" value={settings.paragraphSpacingMm} step={0.1} onChange={(value) => onPageChange("paragraphSpacingMm", value)} />
        <NumberField label="画像高mm" value={settings.imageMaxHeightMm} step={1} onChange={(value) => onPageChange("imageMaxHeightMm", value)} />
      </div>
      <div className="settings-readout">
        <span>本文枠 {textWidthMm.toFixed(1)}×{textHeightMm.toFixed(1)}mm</span>
        <span>1行 約{charsPerLine}字</span>
        <span>行送り {lineAdvanceMm.toFixed(2)}mm</span>
        <span>約{linesPerPage}行/頁</span>
        <span>約{charsPerPage.toLocaleString("ja-JP")}字/頁</span>
        <span>改行後 +{settings.paragraphSpacingMm.toFixed(1)}mm</span>
      </div>

      <div className="toggle-row">
        <label><input type="checkbox" checked={settings.showPageNumber} onChange={(event) => onPageChange("showPageNumber", event.target.checked)} /> ページ番号</label>
        <label><input type="checkbox" checked={settings.showBleedGuide} onChange={(event) => onPageChange("showBleedGuide", event.target.checked)} /> 塗り足し</label>
        <label><input type="checkbox" checked={settings.showSafeArea} onChange={(event) => onPageChange("showSafeArea", event.target.checked)} /> 安全域</label>
      </div>
    </CollapsibleToolPanel>
  );
}

function TableOfContentsPanel({
  entries,
  settings,
  collapsed,
  onToggle,
  onSettingChange,
  onInsert,
  onRefresh,
  onJump
}: {
  entries: TocEntry[];
  settings: TocSettings;
  collapsed: boolean;
  onToggle: () => void;
  onSettingChange: (key: keyof TocSettings, value: TocSettings[keyof TocSettings]) => void;
  onInsert: () => void;
  onRefresh: () => void;
  onJump: (index: number) => void;
}) {
  const tocFontSizePt = settings.fontSizePt ?? 9;
  const tocTitleGapPt = settings.titleGapPt ?? 18;
  const updateTocFontSize = (nextSize: number) => {
    const clampedSize = Math.max(6, Math.min(16, Number(nextSize.toFixed(1))));
    onSettingChange("fontSizePt", clampedSize);
  };
  const updateTocTitleGap = (nextGap: number) => {
    const clampedGap = Math.max(0, Math.min(48, Number(nextGap.toFixed(1))));
    onSettingChange("titleGapPt", clampedGap);
  };

  return (
    <CollapsibleToolPanel title="目次作成" className="toc-panel" collapsed={collapsed} onToggle={onToggle} badge={<span className="mini-badge">H1 {entries.length}件</span>}>
      <div className="toc-form">
        <label className="toc-form-field wide">
          <span>目次タイトル</span>
          <input value={settings.title} onChange={(event) => onSettingChange("title", event.target.value)} />
        </label>
        <label className="toc-form-field wide">
          <span>外観</span>
          <select value={settings.style} onChange={(event) => onSettingChange("style", event.target.value as TocStyleId)}>
            {(Object.entries(TOC_STYLE_OPTIONS) as Array<[TocStyleId, (typeof TOC_STYLE_OPTIONS)[TocStyleId]]>).map(([styleId, option]) => (
              <option key={styleId} value={styleId}>{option.label} - {option.description}</option>
            ))}
          </select>
        </label>
        <div className="toc-form-field wide">
          <span>目次の文字サイズ：{tocFontSizePt}pt</span>
          <div className="toc-size-stepper">
            <button type="button" onClick={() => updateTocFontSize(tocFontSizePt - 0.5)} aria-label="目次の文字を小さくする">
              <Minus size={14} />
            </button>
            <input
              type="number"
              min={6}
              max={16}
              step={0.5}
              value={tocFontSizePt}
              onChange={(event) => updateTocFontSize(Number(event.target.value))}
              aria-label="目次の文字サイズpt"
            />
            <button type="button" onClick={() => updateTocFontSize(tocFontSizePt + 0.5)} aria-label="目次の文字を大きくする">
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="toc-form-field wide">
          <span>タイトル下の余白：{tocTitleGapPt}pt</span>
          <div className="toc-size-stepper">
            <button type="button" onClick={() => updateTocTitleGap(tocTitleGapPt - 1)} aria-label="タイトル下の余白を狭くする">
              <Minus size={14} />
            </button>
            <input
              type="number"
              min={0}
              max={48}
              step={1}
              value={tocTitleGapPt}
              onChange={(event) => updateTocTitleGap(Number(event.target.value))}
              aria-label="タイトル下の余白pt"
            />
            <button type="button" onClick={() => updateTocTitleGap(tocTitleGapPt + 1)} aria-label="タイトル下の余白を広くする">
              <Plus size={14} />
            </button>
          </div>
        </div>
      </div>
      <div className="toc-actions">
        <button type="button" disabled={!entries.length} onClick={onInsert}>
          <ListTree size={16} />
          本文へ挿入
        </button>
        <button type="button" disabled={!entries.length} onClick={onRefresh}>
          更新
        </button>
      </div>
      {entries.length ? (
        <div className="toc-preview-list">
          {entries.map((entry) => (
            <button key={entry.id} className="toc-preview-item" type="button" onClick={() => onJump(entry.index)}>
              <FileText size={15} />
              <span>{entry.title}</span>
              <strong>{entry.page ?? "…"}</strong>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-note">H1見出しを本文に入れると目次にできます。</p>
      )}
    </CollapsibleToolPanel>
  );
}

function DriveSettingsPanel({
  settings,
  isConfigured,
  hasBundledSettings,
  currentFolderId,
  currentFolderName,
  folders,
  collapsed,
  onToggle,
  onChange,
  onSave,
  onClear,
  onLoadFolders,
  onSelectFolder,
  onCreateFolder
}: {
  settings: GoogleDriveSettings;
  isConfigured: boolean;
  hasBundledSettings: boolean;
  currentFolderId: string;
  currentFolderName: string;
  folders: DriveFolder[];
  collapsed: boolean;
  onToggle: () => void;
  onChange: (settings: GoogleDriveSettings) => void;
  onSave: () => void;
  onClear: () => void;
  onLoadFolders: () => void;
  onSelectFolder: (folderId: string) => void;
  onCreateFolder: () => void;
}) {
  const statusLabel = hasBundledSettings ? "アプリ内蔵" : isConfigured ? "開発者設定済み" : "未設定";
  const currentFolderLabel = currentFolderName || (currentFolderId ? "現在の保存先" : "マイドライブ直下");
  const folderOptions =
    currentFolderId && !folders.some((folder) => folder.id === currentFolderId)
      ? [{ id: currentFolderId, name: currentFolderLabel }, ...folders]
      : folders;

  return (
    <CollapsibleToolPanel title="Google Drive設定" className="drive-settings-panel" collapsed={collapsed} onToggle={onToggle} badge={<span className={`mini-badge ${isConfigured ? "is-ok" : ""}`}>{statusLabel}</span>}>
      <div className="drive-folder-box">
        <div className="drive-folder-current">
          <span>保存先</span>
          <strong>{currentFolderLabel}</strong>
        </div>
        <select className="drive-folder-select" value={currentFolderId} disabled={!isConfigured} onChange={(event) => onSelectFolder(event.target.value)}>
          <option value="">マイドライブ直下</option>
          {folderOptions.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <div className="drive-actions">
          <button type="button" disabled={!isConfigured} onClick={onLoadFolders}>
            <FolderOpen size={16} />
            フォルダ取得
          </button>
          <button type="button" disabled={!isConfigured} onClick={onCreateFolder}>
            <Plus size={16} />
            新規フォルダ
          </button>
        </div>
        <p className="drive-note">選んだ保存先はこの原稿に保存され、次回のDrive保存にも引き継がれます。</p>
      </div>
      {hasBundledSettings ? (
        <>
          <p className="drive-note">Drive連携はアプリ側で設定済みです。利用者がGoogle CloudでAPIキーを取得する必要はありません。</p>
          <div className="drive-actions single">
            <button type="button" onClick={onClear}>
              保存済み入力を消す
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="drive-note">この欄は運営・開発者向けです。商品版では利用者にAPI取得をお願いせず、アプリ側に設定を内蔵する想定です。</p>
          <details className="drive-advanced-settings">
            <summary>開発者向け設定を開く</summary>
            <div className="drive-form">
              <label className="drive-form-field">
                <span>OAuthクライアントID</span>
                <input
                  value={settings.clientId}
                  placeholder="xxxxx.apps.googleusercontent.com"
                  onChange={(event) => onChange({ ...settings, clientId: event.target.value })}
                />
              </label>
              <label className="drive-form-field">
                <span>APIキー</span>
                <input value={settings.apiKey} placeholder="AIza..." onChange={(event) => onChange({ ...settings, apiKey: event.target.value })} />
              </label>
            </div>
            <div className="drive-actions">
              <button type="button" onClick={onSave}>
                <CloudCog size={16} />
                設定を保存
              </button>
              <button type="button" onClick={onClear}>
                クリア
              </button>
            </div>
          </details>
        </>
      )}
    </CollapsibleToolPanel>
  );
}

function CheckPanel({
  checks,
  characterCount,
  estimatedPages,
  collapsed,
  onToggle
}: {
  checks: ReturnType<typeof runManuscriptChecks>;
  characterCount: number;
  estimatedPages: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const visibleChecks = checks.filter((check) => check.id !== "characters");

  return (
    <CollapsibleToolPanel title="確認" className="check-panel" collapsed={collapsed} onToggle={onToggle}>
      <div className="check-summary-row">
        <span>{characterCount.toLocaleString("ja-JP")}字</span>
        <span>推定{estimatedPages}p</span>
      </div>
      <div className="check-list">
        {visibleChecks.map((check) => (
          <div key={check.id} className={`check-item ${check.level}`}>
            {check.level === "ok" ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
            <div>
              <strong>{check.label}</strong>
              <span>{check.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </CollapsibleToolPanel>
  );
}

function QrLibraryPanel({
  panelRef,
  links,
  collapsed,
  onToggle,
  onAdd,
  onInsert,
  onUpdate,
  onTemplateChange,
  onDelete
}: {
  panelRef: RefObject<HTMLElement | null>;
  links: QrLink[];
  collapsed: boolean;
  onToggle: () => void;
  onAdd: (draft: QrDraft, mode?: "save" | "insert") => boolean;
  onInsert: (link: QrLink) => void;
  onUpdate: (id: string, draft: QrDraft) => Promise<boolean>;
  onTemplateChange: (id: string, template: QrCardTemplateId) => void;
  onDelete: (id: string) => void;
}) {
  const [newQr, setNewQr] = useState<QrDraft>(() => readStoredQrDraft());
  const [editingQr, setEditingQr] = useState<{ id: string; draft: QrDraft } | null>(null);

  useEffect(() => {
    storeReusableQrDraft(newQr);
  }, [newQr]);

  const handleAdd = (mode: "save" | "insert") => {
    if (onAdd(newQr, mode)) {
      setNewQr(reusableQrDraft(newQr));
    }
  };
  const startEdit = (link: QrLink) => {
    setEditingQr({
      id: link.id,
      draft: {
        name: link.name,
        url: link.url,
        description: link.description,
        category: link.category,
        template: getQrCardTemplateId(link.template)
      }
    });
  };
  const saveEdit = async () => {
    if (!editingQr) {
      return;
    }

    if (await onUpdate(editingQr.id, editingQr.draft)) {
      setEditingQr(null);
    }
  };

  return (
    <CollapsibleToolPanel title="QRリンク" className="qr-library-panel" collapsed={collapsed} onToggle={onToggle} panelRef={panelRef}>
      <div className="qr-form">
        <label className="qr-form-field">
          <span>太字タイトル</span>
          <input placeholder="例: 作品サイト" value={newQr.name} onChange={(event) => setNewQr({ ...newQr, name: event.target.value })} />
        </label>
        <label className="qr-form-field">
          <span>上部ラベル</span>
          <input placeholder="例: 公式サイト" value={newQr.category} onChange={(event) => setNewQr({ ...newQr, category: event.target.value })} />
        </label>
        <label className="qr-form-field wide">
          <span>装飾</span>
          <select aria-label="装飾" value={newQr.template} onChange={(event) => setNewQr({ ...newQr, template: event.target.value as QrCardTemplateId })}>
            {(Object.entries(QR_CARD_TEMPLATES) as Array<[QrCardTemplateId, (typeof QR_CARD_TEMPLATES)[QrCardTemplateId]]>).map(([templateId, template]) => (
              <option key={templateId} value={templateId}>{template.label} - {template.description}</option>
            ))}
          </select>
        </label>
        <label className="qr-form-field wide">
          <span>QRのURL</span>
          <input placeholder="https://..." value={newQr.url} onChange={(event) => setNewQr({ ...newQr, url: event.target.value })} />
        </label>
        <label className="qr-form-field wide">
          <span>説明文</span>
          <textarea rows={3} placeholder="例: 最新情報はこちら" value={newQr.description} onChange={(event) => setNewQr({ ...newQr, description: event.target.value })} />
        </label>
      </div>
      <div className="qr-form-actions">
        <button type="button" onClick={() => handleAdd("save")}>
          <Plus size={16} />
          保存
        </button>
        <button type="button" onClick={() => handleAdd("insert")}>
          <QrCode size={16} />
          本文へ挿入
        </button>
      </div>
      <div className="qr-list">
        {links.map((link) => {
          const template = getQrCardTemplateId(link.template);
          return (
            <div key={link.id} className="qr-link-item">
              <button type="button" title={`${link.name}を本文へ挿入`} aria-label={`${link.name}を本文へ挿入`} onClick={() => void onInsert({ ...link, template })}>
                <QrCode size={16} />
                <span className="qr-link-text">
                  <strong>{link.name}</strong>
                  <span>{QR_CARD_TEMPLATES[template].label} / 上部ラベル: {link.category}</span>
                </span>
              </button>
              <select className="qr-template-select" aria-label={`${link.name}の装飾`} value={template} onChange={(event) => onTemplateChange(link.id, event.target.value as QrCardTemplateId)}>
                {(Object.entries(QR_CARD_TEMPLATES) as Array<[QrCardTemplateId, (typeof QR_CARD_TEMPLATES)[QrCardTemplateId]]>).map(([templateId, templateOption]) => (
                  <option key={templateId} value={templateId}>{templateOption.label}</option>
                ))}
              </select>
              <button className="icon-button small" type="button" title="編集" aria-label={`${link.name}を編集`} onClick={() => startEdit(link)}>
                <Pencil size={15} />
              </button>
              <button className="icon-button small danger" type="button" title="削除" aria-label="削除" onClick={() => onDelete(link.id)}>
                <Trash2 size={15} />
              </button>
              {editingQr?.id === link.id ? (
                <div className="qr-link-editor">
                  <label>
                    <span>太字タイトル</span>
                    <input value={editingQr.draft.name} onChange={(event) => setEditingQr({ ...editingQr, draft: { ...editingQr.draft, name: event.target.value } })} />
                  </label>
                  <label>
                    <span>上部ラベル</span>
                    <input value={editingQr.draft.category} onChange={(event) => setEditingQr({ ...editingQr, draft: { ...editingQr.draft, category: event.target.value } })} />
                  </label>
                  <label>
                    <span>装飾</span>
                    <select value={editingQr.draft.template} onChange={(event) => setEditingQr({ ...editingQr, draft: { ...editingQr.draft, template: event.target.value as QrCardTemplateId } })}>
                      {(Object.entries(QR_CARD_TEMPLATES) as Array<[QrCardTemplateId, (typeof QR_CARD_TEMPLATES)[QrCardTemplateId]]>).map(([templateId, templateOption]) => (
                        <option key={templateId} value={templateId}>{templateOption.label} - {templateOption.description}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>QRのURL</span>
                    <input value={editingQr.draft.url} onChange={(event) => setEditingQr({ ...editingQr, draft: { ...editingQr.draft, url: event.target.value } })} />
                  </label>
                  <label className="wide">
                    <span>説明文</span>
                    <textarea rows={3} value={editingQr.draft.description} onChange={(event) => setEditingQr({ ...editingQr, draft: { ...editingQr.draft, description: event.target.value } })} />
                  </label>
                  <div className="qr-link-editor-actions">
                    <button type="button" onClick={() => void saveEdit()}>保存</button>
                    <button type="button" onClick={() => setEditingQr(null)}>閉じる</button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </CollapsibleToolPanel>
  );
}

function NumberField({
  label,
  value,
  step = 1,
  onChange
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(() => String(value));
  const isFocusedRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) {
      setDraftValue(String(value));
    }
  }, [value]);

  const handleChange = (nextValue: string) => {
    setDraftValue(nextValue);
    if (!nextValue.trim()) {
      return;
    }

    const parsed = Number(nextValue);
    if (Number.isFinite(parsed) && parsed >= 0) {
      onChange(parsed);
    }
  };

  const handleBlur = () => {
    isFocusedRef.current = false;
    const parsed = Number(draftValue);
    setDraftValue(Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : String(value));
  };

  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        type="number"
        value={draftValue}
        min={0}
        step={step}
        onFocus={() => {
          isFocusedRef.current = true;
        }}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={handleBlur}
      />
    </label>
  );
}

