"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import QRCode from "qrcode";
import {
  BookOpen,
  CheckCircle2,
  Cloud,
  CloudCog,
  FileJson,
  FileText,
  FolderOpen,
  ListTree,
  Minus,
  Pencil,
  Plus,
  Printer,
  QrCode,
  Save,
  Trash2,
  XCircle
} from "lucide-react";
import { TiptapEditor, TiptapToolbar } from "./TiptapEditor";
import { MANUSCRIPT_FONTS, PAGE_PRESETS, applyPreset, countManuscriptCharacters, createDefaultProject, estimatePageCount, isValidUrl, normalizeProject, runManuscriptChecks } from "@/lib/defaultProject";
import type { Chapter, ManuscriptFontId, ManuscriptProject, PagePresetId, PageSettings, QrCardTemplateId, QrLink, TocSettings, TocStyleId } from "@/lib/types";
import { exportProjectJson, loadProjectFromBrowser, readJsonFile, saveProjectToBrowser } from "@/lib/storage";
import { clearGoogleDriveSettings, connectGoogleDrive, isDriveConfigured, loadGoogleDriveSettings, resetGoogleDriveClient, saveGoogleDriveSettings, type GoogleDriveSettings } from "@/lib/googleDrive";
import { exportProjectDocx, exportProjectEpub, exportProjectPdf } from "@/lib/exporters";

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
const FAST_EDITING_RESET_MS = 850;

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

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [delayMs, value]);

  return debouncedValue;
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
  }
};

const EMPTY_QR_DRAFT: QrDraft = { name: "", url: "", description: "", category: "公式サイト", template: "umbrella" };
const EMPTY_DRIVE_SETTINGS: GoogleDriveSettings = { clientId: "", apiKey: "" };

const TOC_STYLE_OPTIONS: Record<TocStyleId, { label: string; description: string }> = {
  classic: {
    label: "クラシック",
    description: "白地に細い罫線"
  },
  rain: {
    label: "雨の手紙",
    description: "青緑の淡い装飾"
  },
  antique: {
    label: "古書",
    description: "古紙風の装飾"
  },
  midnight: {
    label: "夜祭",
    description: "濃色に金色の罫線"
  }
};

function getQrCardTemplateId(value: QrCardTemplateId | undefined): QrCardTemplateId {
  return value && QR_CARD_TEMPLATES[value] ? value : "umbrella";
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

function googleDriveSetupMessage(): string {
  return [
    "Google Drive連携にはGoogle CloudのOAuth設定が必要です。",
    "",
    "1. Google Cloud ConsoleでGoogle Drive APIを有効化",
    "2. OAuth同意画面を作成",
    "3. OAuthクライアントID（ウェブ）とAPIキーを作成",
    "4. 承認済みのJavaScript生成元に https://umbrellaparade.github.io を追加",
    "5. 右サイドバーのGoogle Drive設定にクライアントIDとAPIキーを入力"
  ].join("\n");
}

function tocItemsJson(entries: TocEntry[]): string {
  return JSON.stringify(entries.map((entry) => ({ title: entry.title, page: entry.page })));
}

function tableOfContentsAttrs(settings: TocSettings, entries: TocEntry[]) {
  return {
    title: settings.title.trim() || "目次",
    subtitle: settings.subtitle,
    style: settings.style,
    fontSizePt: settings.fontSizePt ?? null,
    items: tocItemsJson(entries)
  };
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
          node.attrs.items === nextAttrs.items;
        if (!isSame) {
          tr.setNodeMarkup(position, undefined, nextAttrs, node.marks);
          changed = true;
        }
      });
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
  const [driveSettingsDraft, setDriveSettingsDraft] = useState<GoogleDriveSettings>(EMPTY_DRIVE_SETTINGS);
  const [measuredPages, setMeasuredPages] = useState<{ signature: string; count: number } | null>(null);
  const [pageSectionTitles, setPageSectionTitles] = useState<string[]>([]);
  const [headingPageNumbers, setHeadingPageNumbers] = useState<number[]>([]);
  const [pageFit, setPageFit] = useState({ scale: 1, width: 0, height: 0, pageStep: 0 });
  const [visibleSpreadIndex, setVisibleSpreadIndex] = useState(0);
  const [printDomActive, setPrintDomActive] = useState(false);
  const [fastEditing, setFastEditing] = useState(false);
  const pageStageRef = useRef<HTMLDivElement | null>(null);
  const visibleSpreadIndexRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingScrollTopRef = useRef(0);
  const fastEditingRef = useRef(false);
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
    };
  }, []);

  useEffect(() => {
    fastEditingRef.current = fastEditing;
  }, [fastEditing]);

  useEffect(() => {
    const activatePrintDom = () => setPrintDomActive(true);
    const deactivatePrintDom = () => setPrintDomActive(false);

    window.addEventListener("beforeprint", activatePrintDom);
    window.addEventListener("afterprint", deactivatePrintDom);
    return () => {
      window.removeEventListener("beforeprint", activatePrintDom);
      window.removeEventListener("afterprint", deactivatePrintDom);
    };
  }, []);

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
  const activeChapterContent = activeChapter?.content ?? "";
  const layoutChapterContent = useDebouncedValue(activeChapterContent, LAYOUT_REFRESH_DELAY_MS);
  const layoutProject = useMemo(() => {
    if (!project || !activeChapter) {
      return null;
    }

    return {
      ...project,
      chapters: project.chapters.map((chapter, index) => (index === 0 ? { ...chapter, content: layoutChapterContent } : chapter))
    };
  }, [activeChapter, layoutChapterContent, project]);
  const outlineItems = useMemo(() => extractOutlineItems(layoutChapterContent), [layoutChapterContent]);
  const tocEntries = useMemo<TocEntry[]>(
    () => outlineItems.map((item) => ({ ...item, page: headingPageNumbers[item.index] ?? null })),
    [headingPageNumbers, outlineItems]
  );
  const printChapter = useMemo(() => (activeChapter ? { ...activeChapter, content: layoutChapterContent } : null), [activeChapter, layoutChapterContent]);

  const checks = useMemo(() => (layoutProject ? runManuscriptChecks(layoutProject) : []), [layoutProject]);
  const estimatedPages = useMemo(() => (layoutProject ? estimatePageCount(layoutProject) : 1), [layoutProject]);
  const characterCount = useMemo(() => (layoutProject ? countManuscriptCharacters(layoutProject) : 0), [layoutProject]);
  const layoutSignature = useMemo(() => {
    if (!project || !activeChapter) {
      return "";
    }

    return JSON.stringify({
      activeChapterId: activeChapter.id,
      content: layoutChapterContent,
      pageSettings: project.pageSettings
    });
  }, [activeChapter, layoutChapterContent, project]);
  const measuredPageCount = measuredPages?.signature === layoutSignature ? measuredPages.count : null;
  const pageFrameCount = Math.max(1, Math.min(Math.max(estimatedPages, measuredPageCount ?? 0), MAX_PAGE_FRAMES));
  const pageSpreads = useMemo(() => buildPageSpreads(pageFrameCount), [pageFrameCount]);
  const clampedVisibleSpreadIndex = Math.max(0, Math.min(visibleSpreadIndex, pageSpreads.length - 1));
  const visibleSpread = pageSpreads[clampedVisibleSpreadIndex] ?? pageSpreads[0] ?? { id: "page-1", pages: [0] };
  const spreadStartPageIndex = visibleSpread.pages[0] ?? 0;
  const spreadPageCount = Math.max(1, visibleSpread.pages.length);
  const maxSpreadPageCount = pageSpreads.some((spread) => spread.pages.length > 1) ? 2 : 1;
  const pageViewportStyle = {
    "--page-scale": pageFit.scale,
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

  const markTypingActivity = useCallback(() => {
    if (!fastEditingRef.current) {
      fastEditingRef.current = true;
      setFastEditing(true);
    }
    if (fastEditingTimerRef.current !== null) {
      window.clearTimeout(fastEditingTimerRef.current);
    }
    fastEditingTimerRef.current = window.setTimeout(() => {
      fastEditingTimerRef.current = null;
      fastEditingRef.current = false;
      setFastEditing(false);
    }, FAST_EDITING_RESET_MS);
  }, []);

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

  const updateVisibleSpreadFromScroll = useCallback(
    (stage: HTMLDivElement, scrollTop: number) => {
      stage.style.setProperty("--page-scroll-top", `${scrollTop}px`);
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
      if (scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(flushScroll);
    };

    pendingScrollTopRef.current = stage.scrollTop;
    updateVisibleSpreadFromScroll(stage, stage.scrollTop);
    stage.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      stage.removeEventListener("scroll", handleScroll);
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [updateVisibleSpreadFromScroll]);

  useEffect(() => {
    const nextSpreadIndex = Math.max(0, Math.min(visibleSpreadIndexRef.current, pageSpreads.length - 1));
    if (nextSpreadIndex !== visibleSpreadIndexRef.current) {
      visibleSpreadIndexRef.current = nextSpreadIndex;
      setVisibleSpreadIndex(nextSpreadIndex);
    }
  }, [pageSpreads.length]);

  useEffect(() => {
    if (!layoutSignature) {
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

      const actualPages = Math.ceil((prose.scrollWidth + 1) / pagePitch);
      const nextCount = Math.max(estimatedPages, actualPages);
      const titleCount = Math.max(1, Math.min(nextCount, MAX_PAGE_FRAMES));
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

      if (Number.isFinite(nextCount) && nextCount > pageFrameCount) {
        setMeasuredPages({ signature: layoutSignature, count: Math.min(nextCount, MAX_PAGE_FRAMES) });
      }
    });

    return () => window.cancelAnimationFrame(handle);
  }, [estimatedPages, layoutSignature, pageFit.scale, pageFrameCount, spreadStartPageIndex]);

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
        const nextFit = {
          scale: Number(scale.toFixed(4)),
          width: Math.ceil(visibleSpreadWidth * scale),
          height: Math.ceil(pageSpreads.length * scaledPageHeight + Math.max(0, pageSpreads.length - 1) * scaledPageGap),
          pageStep: Math.max(1, scaledPageHeight + scaledPageGap)
        };
        setPageFit((previous) =>
          previous.scale === nextFit.scale && previous.width === nextFit.width && previous.height === nextFit.height && previous.pageStep === nextFit.pageStep
            ? previous
            : nextFit
        );
      });
    };

    const resizeObserver = new ResizeObserver(updatePageFit);
    resizeObserver.observe(stage);
    updatePageFit();
    window.addEventListener("resize", updatePageFit);
    return () => {
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", updatePageFit);
    };
  }, [layoutSignature, maxSpreadPageCount, pageSpreads.length, spreadPageCount]);

  useEffect(() => {
    if (!activeEditor || !project || fastEditing) {
      return;
    }

    syncTableOfContentsNodes(activeEditor, project.tocSettings, tocEntries);
  }, [activeEditor, fastEditing, project, tocEntries]);

  if (!project || !activeChapter) {
    return (
      <main className="app-loading">
        <div className="loading-mark" />
        <p>原稿を開いています</p>
      </main>
    );
  }

  const pageStyle = {
    "--page-width": `${project.pageSettings.pageWidthMm}mm`,
    "--page-height": `${project.pageSettings.pageHeightMm}mm`,
    "--page-aspect": `${project.pageSettings.pageWidthMm} / ${project.pageSettings.pageHeightMm}`,
    "--margin-top": `${project.pageSettings.marginTopMm}mm`,
    "--margin-bottom": `${project.pageSettings.marginBottomMm}mm`,
    "--margin-left": `${project.pageSettings.marginLeftMm}mm`,
    "--margin-right": `${project.pageSettings.marginRightMm}mm`,
    "--manuscript-font-family": MANUSCRIPT_FONTS[project.pageSettings.fontFamily ?? "noto-serif-jp"].css,
    "--manuscript-font-size": `${project.pageSettings.fontSizePt}pt`,
    "--ruby-font-size": `${project.pageSettings.rubySizePt}pt`,
    "--line-height": project.pageSettings.lineHeight,
    "--paragraph-spacing": `${project.pageSettings.paragraphSpacingMm}mm`,
    "--image-max-height": `${project.pageSettings.imageMaxHeightMm}mm`,
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
      visibleSpreadIndexRef.current = targetSpreadIndex;
      setVisibleSpreadIndex(targetSpreadIndex);
      stage.scrollTo({ top: targetSpreadIndex * Math.max(1, pageFit.pageStep), behavior: "smooth" });
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

  const updateTocSetting = (key: keyof TocSettings, value: TocSettings[keyof TocSettings]) => {
    updateProject((previous) => ({
      ...previous,
      tocSettings: {
        ...previous.tocSettings,
        [key]: value
      }
    }));
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
          attrs: tableOfContentsAttrs(project.tocSettings, tocEntries)
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

  const exportJson = () => {
    const latestProject = projectWithLatestContent(project);
    exportProjectJson(latestProject);
    flushPendingChapterContent();
    setStatusText("JSONを書き出し");
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
      const client = driveClient ?? (await connectGoogleDrive());
      setDriveClient(client);
      const result = await client.saveProject(latestProject);
      flushPendingChapterContent();
      updateProject((previous) => ({
        ...previous,
        drive: {
          fileId: result.fileId,
          lastSavedAt: result.savedAt
        }
      }));
      setStatusText("Google Drive保存");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Google Drive保存に失敗しました。");
    }
  };

  const exportPdf = async () => {
    try {
      setStatusText("本用PDFを作成中");
      const latestProject = projectWithLatestContent(project);
      await exportProjectPdf(latestProject);
      flushPendingChapterContent();
      setStatusText("本用PDFを書き出し");
    } catch (error) {
      setStatusText("PDF書き出しに失敗");
      window.console.error(error);
      window.alert(error instanceof Error ? error.message : "PDFを書き出せませんでした。");
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
      <style>{printStyle(project)}</style>
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
          <button className="command-button" type="button" onClick={exportPdf} title="本用PDF出力">
            <Printer size={17} />
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
          <OutlinePanel items={outlineItems} onJump={jumpToHeading} />
          <TableOfContentsPanel
            entries={tocEntries}
            settings={project.tocSettings}
            onSettingChange={updateTocSetting}
            onInsert={insertTableOfContents}
            onRefresh={refreshTableOfContents}
          />
          <ProjectPanel
            project={project}
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
        <div ref={pageStageRef} className="page-stage">
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
        </section>

        <aside className={`right-rail mobile-panel ${mobileTab === "check" ? "is-mobile-active" : ""}`}>
          <QrLibraryPanel
            panelRef={qrPanelRef}
            links={project.qrLinks}
            onAdd={addQrLink}
            onInsert={insertQrLink}
            onUpdate={updateQrLink}
            onTemplateChange={updateQrLinkTemplate}
            onDelete={(id) => updateProject((previous) => ({ ...previous, qrLinks: previous.qrLinks.filter((link) => link.id !== id) }))}
          />
          <DriveSettingsPanel
            settings={driveSettingsDraft}
            isConfigured={isDriveConfigured()}
            onChange={setDriveSettingsDraft}
            onSave={saveDriveSettingsFromDraft}
            onClear={clearDriveSettingsFromDraft}
          />
          <CheckPanel checks={checks} characterCount={characterCount} estimatedPages={estimatedPages} />
        </aside>
      </div>
      {printDomActive && printChapter ? <PrintDocument project={project} chapter={printChapter} sectionTitles={pageSectionTitles} pageCount={pageFrameCount} /> : null}
    </main>
  );
}

function PrintDocument({
  project,
  chapter,
  sectionTitles,
  pageCount
}: {
  project: ManuscriptProject;
  chapter: Chapter;
  sectionTitles: string[];
  pageCount: number;
}) {
  const page = project.pageSettings;
  const contentWidthMm = Math.max(1, page.pageWidthMm - page.marginLeftMm - page.marginRightMm);
  const pagePitchMm = contentWidthMm + page.marginLeftMm + page.marginRightMm + PAGE_GAP_MM;

  return (
    <div className="print-document" aria-hidden="true">
      {Array.from({ length: pageCount }, (_, pageIndex) => (
        <section key={pageIndex} className="print-page">
          <header className="print-page-header">
            {sectionTitles[pageIndex] ? <span>{sectionTitles[pageIndex]}</span> : null}
          </header>
          {page.showBleedGuide ? <div className="print-bleed-guide" /> : null}
          {page.showSafeArea ? <div className="print-safe-guide" /> : null}
          <div className="print-content-window">
            <div
              className="print-flow manuscript-prose"
              style={{ marginLeft: `-${pageIndex * pagePitchMm}mm` }}
              dangerouslySetInnerHTML={{ __html: chapter.content }}
            />
          </div>
          <footer className="print-page-footer">
            {page.showPageNumber ? <span>{pageIndex + 1}</span> : null}
          </footer>
        </section>
      ))}
    </div>
  );
}

function ProjectPanel({
  project,
  onProjectChange,
  onPreset,
  onPageChange,
  onReset
}: {
  project: ManuscriptProject;
  onProjectChange: (updater: (previous: ManuscriptProject) => ManuscriptProject) => void;
  onPreset: (preset: PagePresetId) => void;
  onPageChange: (key: keyof PageSettings, value: PageSettings[keyof PageSettings]) => void;
  onReset: () => void;
}) {
  const settings = project.pageSettings;
  const fontSizeMm = settings.fontSizePt * 0.352778;
  const lineAdvanceMm = Math.max(0.1, fontSizeMm * settings.lineHeight);
  const textHeightMm = Math.max(0, settings.pageHeightMm - settings.marginTopMm - settings.marginBottomMm);
  const linesPerPage = Math.max(1, Math.floor(textHeightMm / lineAdvanceMm));
  const updateProjectText = (key: "title" | "subtitle" | "author", value: string) => {
    onProjectChange((previous) => ({ ...previous, [key]: value }));
  };

  return (
    <section className="tool-panel">
      <div className="panel-title-row">
        <h2>プロジェクト</h2>
        <button className="icon-button" type="button" title="新規" aria-label="新規" onClick={onReset}>
          <Plus size={17} />
        </button>
      </div>
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
        <NumberField label="段落mm" value={settings.paragraphSpacingMm} step={0.1} onChange={(value) => onPageChange("paragraphSpacingMm", value)} />
        <NumberField label="画像高mm" value={settings.imageMaxHeightMm} step={1} onChange={(value) => onPageChange("imageMaxHeightMm", value)} />
      </div>
      <div className="settings-readout">
        <span>行送り {lineAdvanceMm.toFixed(2)}mm</span>
        <span>約{linesPerPage}行/頁</span>
      </div>

      <div className="toggle-row">
        <label><input type="checkbox" checked={settings.showPageNumber} onChange={(event) => onPageChange("showPageNumber", event.target.checked)} /> ページ番号</label>
        <label><input type="checkbox" checked={settings.showBleedGuide} onChange={(event) => onPageChange("showBleedGuide", event.target.checked)} /> 塗り足し</label>
        <label><input type="checkbox" checked={settings.showSafeArea} onChange={(event) => onPageChange("showSafeArea", event.target.checked)} /> 安全域</label>
      </div>
    </section>
  );
}

function OutlinePanel({ items, onJump }: { items: OutlineItem[]; onJump: (index: number) => void }) {
  return (
    <section className="tool-panel outline-panel">
      <div className="panel-title-row">
        <h2>目次</h2>
        <span className="mini-badge">H1 {items.length}件</span>
      </div>
      {items.length ? (
        <div className="outline-list">
          {items.map((item) => (
            <button key={item.id} className="outline-item" type="button" onClick={() => onJump(item.index)}>
              <FileText size={15} />
              <span>{item.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-note">本文にH1見出しを入れると自動で表示されます。</p>
      )}
    </section>
  );
}

function TableOfContentsPanel({
  entries,
  settings,
  onSettingChange,
  onInsert,
  onRefresh
}: {
  entries: TocEntry[];
  settings: TocSettings;
  onSettingChange: (key: keyof TocSettings, value: TocSettings[keyof TocSettings]) => void;
  onInsert: () => void;
  onRefresh: () => void;
}) {
  const tocFontSizePt = settings.fontSizePt ?? 9;
  const updateTocFontSize = (nextSize: number) => {
    const clampedSize = Math.max(6, Math.min(16, Number(nextSize.toFixed(1))));
    onSettingChange("fontSizePt", clampedSize);
  };

  return (
    <section className="tool-panel toc-panel">
      <div className="panel-title-row">
        <h2>目次作成</h2>
        <span className="mini-badge">H1 {entries.length}件</span>
      </div>
      <div className="toc-form">
        <label className="toc-form-field">
          <span>目次タイトル</span>
          <input value={settings.title} onChange={(event) => onSettingChange("title", event.target.value)} />
        </label>
        <label className="toc-form-field">
          <span>副題</span>
          <input placeholder="例: 雨の章だより" value={settings.subtitle} onChange={(event) => onSettingChange("subtitle", event.target.value)} />
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
              type="range"
              min="6"
              max="16"
              step="0.5"
              value={tocFontSizePt}
              onChange={(event) => updateTocFontSize(Number.parseFloat(event.target.value))}
            />
            <button type="button" onClick={() => updateTocFontSize(tocFontSizePt + 0.5)} aria-label="目次の文字を大きくする">
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
          {entries.slice(0, 8).map((entry) => (
            <div key={entry.id} className="toc-preview-item">
              <span>{entry.title}</span>
              <strong>{entry.page ?? "…"}</strong>
            </div>
          ))}
          {entries.length > 8 ? <p className="empty-note">ほか {entries.length - 8} 件</p> : null}
        </div>
      ) : (
        <p className="empty-note">H1見出しを本文に入れると目次にできます。</p>
      )}
    </section>
  );
}

function DriveSettingsPanel({
  settings,
  isConfigured,
  onChange,
  onSave,
  onClear
}: {
  settings: GoogleDriveSettings;
  isConfigured: boolean;
  onChange: (settings: GoogleDriveSettings) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <section className="tool-panel drive-settings-panel">
      <div className="panel-title-row">
        <h2>Google Drive設定</h2>
        <span className={`mini-badge ${isConfigured ? "is-ok" : ""}`}>{isConfigured ? "設定済み" : "未設定"}</span>
      </div>
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
    </section>
  );
}

function CheckPanel({
  checks,
  characterCount,
  estimatedPages
}: {
  checks: ReturnType<typeof runManuscriptChecks>;
  characterCount: number;
  estimatedPages: number;
}) {
  const visibleChecks = checks.filter((check) => check.id !== "characters");

  return (
    <section className="tool-panel check-panel">
      <div className="panel-title-row">
        <h2>確認</h2>
      </div>
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
    </section>
  );
}

function QrLibraryPanel({
  panelRef,
  links,
  onAdd,
  onInsert,
  onUpdate,
  onTemplateChange,
  onDelete
}: {
  panelRef: RefObject<HTMLElement | null>;
  links: QrLink[];
  onAdd: (draft: QrDraft, mode?: "save" | "insert") => boolean;
  onInsert: (link: QrLink) => void;
  onUpdate: (id: string, draft: QrDraft) => Promise<boolean>;
  onTemplateChange: (id: string, template: QrCardTemplateId) => void;
  onDelete: (id: string) => void;
}) {
  const [newQr, setNewQr] = useState<QrDraft>(EMPTY_QR_DRAFT);
  const [editingQr, setEditingQr] = useState<{ id: string; draft: QrDraft } | null>(null);
  const handleAdd = (mode: "save" | "insert") => {
    onAdd(newQr, mode);
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
    <section ref={panelRef} className="tool-panel qr-library-panel">
      <div className="panel-title-row">
        <h2>QRリンク</h2>
      </div>
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
          <input placeholder="例: 最新情報はこちら" value={newQr.description} onChange={(event) => setNewQr({ ...newQr, description: event.target.value })} />
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
                    <input value={editingQr.draft.description} onChange={(event) => setEditingQr({ ...editingQr, draft: { ...editingQr.draft, description: event.target.value } })} />
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
    </section>
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
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={0}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function printStyle(project: ManuscriptProject) {
  const page = project.pageSettings;
  return `
    .print-document {
      display: none;
    }

    @media print {
      @page {
        size: ${page.pageWidthMm}mm ${page.pageHeightMm}mm;
        margin: 0;
      }

      html,
      body {
        background: #ffffff !important;
        width: ${page.pageWidthMm}mm !important;
        min-height: auto !important;
        overflow: visible !important;
      }

      .app-shell > :not(.print-document) {
        display: none !important;
      }

      .app-shell {
        display: block !important;
        background: #ffffff !important;
        margin: 0 !important;
        padding: 0 !important;
        width: ${page.pageWidthMm}mm !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
      }

      .print-document {
        display: block !important;
        width: ${page.pageWidthMm}mm !important;
        margin: 0 !important;
        padding: 0 !important;
        background: #ffffff !important;
      }

      .print-page {
        position: relative;
        width: ${page.pageWidthMm}mm !important;
        height: ${page.pageHeightMm}mm !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: #ffffff !important;
        color: #1f1d1a !important;
        box-shadow: none !important;
        break-after: page;
        page-break-after: always;
        print-color-adjust: exact;
        -webkit-print-color-adjust: exact;
      }

      .print-page:last-child {
        break-after: auto;
        page-break-after: auto;
      }

      .print-page-header,
      .print-page-footer {
        position: absolute;
        left: ${page.marginLeftMm}mm;
        right: ${page.marginRightMm}mm;
        z-index: 3;
        display: flex;
        justify-content: flex-end;
        gap: 4mm;
        overflow: hidden;
        color: #7a7168;
        font-family: var(--font-sans), sans-serif;
        font-size: 7pt;
        line-height: 1.25;
      }

      .print-page-header {
        top: max(2mm, calc(${page.marginTopMm}mm / 2 - 3pt));
      }

      .print-page-footer {
        bottom: max(2mm, calc(${page.marginBottomMm}mm / 2 - 3pt));
      }

      .print-page-header span,
      .print-page-footer span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .print-bleed-guide,
      .print-safe-guide {
        display: none !important;
      }

      .print-content-window {
        position: absolute;
        top: ${page.marginTopMm}mm;
        left: ${page.marginLeftMm}mm;
        z-index: 1;
        width: calc(${page.pageWidthMm}mm - ${page.marginLeftMm}mm - ${page.marginRightMm}mm);
        height: calc(${page.pageHeightMm}mm - ${page.marginTopMm}mm - ${page.marginBottomMm}mm);
        overflow: hidden !important;
      }

      .print-flow.manuscript-prose {
        width: var(--paged-content-width) !important;
        height: calc(${page.pageHeightMm}mm - ${page.marginTopMm}mm - ${page.marginBottomMm}mm) !important;
        min-height: calc(${page.pageHeightMm}mm - ${page.marginTopMm}mm - ${page.marginBottomMm}mm) !important;
        max-height: none !important;
        columns: calc(${page.pageWidthMm}mm - ${page.marginLeftMm}mm - ${page.marginRightMm}mm) auto !important;
        column-width: calc(${page.pageWidthMm}mm - ${page.marginLeftMm}mm - ${page.marginRightMm}mm) !important;
        column-gap: calc(${page.marginLeftMm}mm + ${page.marginRightMm}mm + ${PAGE_GAP_MM}mm) !important;
        column-fill: auto !important;
        overflow: visible !important;
        outline: 0 !important;
      }

      .print-flow .page-break-before,
      .print-flow [data-page-break-before="true"] {
        break-before: column !important;
      }

      .print-flow .page-break-before::before,
      .print-flow [data-page-break-before="true"]::before {
        content: none !important;
      }

      .print-flow .page-break {
        height: 1px !important;
        margin: 0 !important;
        border: 0 !important;
        break-after: column !important;
      }

      .print-flow .page-break::before {
        content: none !important;
      }
    }
  `;
}
