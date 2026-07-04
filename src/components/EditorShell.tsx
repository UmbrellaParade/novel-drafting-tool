"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import QRCode from "qrcode";
import {
  CheckCircle2,
  Cloud,
  Download,
  FileDown,
  FileJson,
  FileText,
  FolderOpen,
  Plus,
  Printer,
  QrCode,
  Save,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";
import { TiptapEditor, TiptapToolbar } from "./TiptapEditor";
import { MANUSCRIPT_FONTS, PAGE_PRESETS, applyPreset, countManuscriptCharacters, createDefaultProject, estimatePageCount, isValidUrl, runManuscriptChecks, sanitizeFileName } from "@/lib/defaultProject";
import type { Chapter, ManuscriptFontId, ManuscriptProject, PagePresetId, PageSettings, QrLink } from "@/lib/types";
import { exportProjectJson, loadProjectFromBrowser, readJsonFile, saveProjectToBrowser } from "@/lib/storage";
import { connectGoogleDrive, isDriveConfigured } from "@/lib/googleDrive";
import { exportProjectDocx, exportProjectPdf } from "@/lib/exporters";

type MobileTab = "draft" | "chapters" | "check" | "export";

type DriveClient = Awaited<ReturnType<typeof connectGoogleDrive>>;

const tabLabels: Record<MobileTab, string> = {
  draft: "本文",
  chapters: "目次",
  check: "確認",
  export: "出力"
};

const PAGE_GAP_MM = 14;
const MAX_PAGE_FRAMES = 160;
const DOCUMENT_CHAPTER_TITLE = "本文";

type OutlineItem = {
  id: string;
  title: string;
  index: number;
};

type QrDraft = {
  name: string;
  url: string;
  description: string;
  category: string;
};

const EMPTY_QR_DRAFT: QrDraft = { name: "", url: "", description: "", category: "公式" };

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

function normalizeDocumentProject(project: ManuscriptProject): ManuscriptProject {
  const savedChapters = Array.isArray(project.chapters) ? project.chapters : [];
  const chapters = savedChapters.length
    ? savedChapters
    : [{ id: crypto.randomUUID(), title: DOCUMENT_CHAPTER_TITLE, content: "<p></p>" }];

  if (chapters.length === 1) {
    const [chapter] = chapters;
    return {
      ...project,
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
    ...project,
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
  if (typeof document === "undefined") {
    return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match, index) => ({
      id: `heading-${index}`,
      title: match[1].replace(/<[^>]*>/g, "").trim() || `見出し ${index + 1}`,
      index
    }));
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  return [...template.content.querySelectorAll("h1")].map((heading, index) => ({
    id: `heading-${index}`,
    title: heading.textContent?.trim() || `見出し ${index + 1}`,
    index
  }));
}

export function EditorShell() {
  const [project, setProject] = useState<ManuscriptProject | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("draft");
  const [statusText, setStatusText] = useState("起動中");
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [driveClient, setDriveClient] = useState<DriveClient | null>(null);
  const [measuredPages, setMeasuredPages] = useState<{ signature: string; count: number } | null>(null);
  const pageStageRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

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
    }, 500);

    return () => window.clearTimeout(handle);
  }, [project]);

  const activeChapter = useMemo(() => {
    if (!project) {
      return null;
    }
    return project.chapters[0] ?? null;
  }, [project]);
  const activeChapterContent = activeChapter?.content ?? "";
  const outlineItems = useMemo(() => extractOutlineItems(activeChapterContent), [activeChapterContent]);
  const activeSectionTitle = outlineItems[0]?.title ?? DOCUMENT_CHAPTER_TITLE;

  const checks = useMemo(() => (project ? runManuscriptChecks(project) : []), [project]);
  const estimatedPages = useMemo(() => (project ? estimatePageCount(project) : 1), [project]);
  const layoutSignature = useMemo(() => {
    if (!project || !activeChapter) {
      return "";
    }

    return JSON.stringify({
      activeChapterId: activeChapter.id,
      content: activeChapter.content,
      pageSettings: project.pageSettings
    });
  }, [activeChapter, project]);
  const measuredPageCount = measuredPages?.signature === layoutSignature ? measuredPages.count : null;
  const pageFrameCount = Math.max(1, Math.min(Math.max(estimatedPages, measuredPageCount ?? 0), MAX_PAGE_FRAMES));

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

  const updateActiveChapterContent = useCallback(
    (content: string) => {
      updateProject((previous) => {
        const documentId = previous.chapters[0]?.id ?? crypto.randomUUID();
        return {
          ...previous,
          chapters: [
            {
              ...(previous.chapters[0] ?? { id: documentId, title: DOCUMENT_CHAPTER_TITLE }),
              id: documentId,
              title: DOCUMENT_CHAPTER_TITLE,
              content
            }
          ],
          activeChapterId: documentId
        };
      });
    },
    [updateProject]
  );

  const handlePageStageWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }

    const stage = event.currentTarget;
    const maxScrollLeft = stage.scrollWidth - stage.clientWidth;
    if (maxScrollLeft <= 0) {
      return;
    }

    const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, stage.scrollLeft + event.deltaY));
    if (nextScrollLeft === stage.scrollLeft) {
      return;
    }

    event.preventDefault();
    stage.scrollLeft = nextScrollLeft;
  }, []);

  useEffect(() => {
    if (!project || !activeChapter || !layoutSignature) {
      return;
    }

    const handle = window.requestAnimationFrame(() => {
      const stage = pageStageRef.current;
      const prose = stage?.querySelector<HTMLElement>(".paged-editor-layer .manuscript-prose");
      const firstFrame = stage?.querySelector<HTMLElement>(".page-frame");
      const secondFrame = stage?.querySelectorAll<HTMLElement>(".page-frame")[1];
      if (!prose || !firstFrame) {
        return;
      }

      const pagePitch = secondFrame ? secondFrame.offsetLeft - firstFrame.offsetLeft : firstFrame.offsetWidth;
      if (pagePitch <= 0) {
        return;
      }

      const actualPages = Math.ceil((prose.scrollWidth + 1) / pagePitch);
      const nextCount = Math.max(estimatedPages, actualPages);
      if (Number.isFinite(nextCount) && nextCount > pageFrameCount) {
        setMeasuredPages({ signature: layoutSignature, count: Math.min(nextCount, MAX_PAGE_FRAMES) });
      }
    });

    return () => window.cancelAnimationFrame(handle);
  }, [activeChapter, estimatedPages, layoutSignature, pageFrameCount, project]);

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
      const headings = pageStageRef.current?.querySelectorAll<HTMLElement>(".manuscript-prose h1");
      const target = headings?.[index];
      target?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    });
  };

  const handlePreset = (preset: PagePresetId) => {
    updateProject((previous) => ({
      ...previous,
      pageSettings: applyPreset(previous.pageSettings, preset)
    }));
  };

  const updatePageSetting = (key: keyof PageSettings, value: PageSettings[keyof PageSettings]) => {
    updateProject((previous) => ({
      ...previous,
      pageSettings: {
        ...previous.pageSettings,
        [key]: value
      }
    }));
  };

  const exportJson = () => {
    exportProjectJson(project);
    setStatusText("JSONを書き出し");
  };

  const manualSave = async () => {
    try {
      await saveProjectToBrowser(project);
      setStatusText(`ブラウザ保存 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`);
    } catch (error) {
      setStatusText("ブラウザ保存に失敗");
      window.alert(error instanceof Error ? error.message : "ブラウザ保存に失敗しました。");
    }
  };

  const importJson = async (file: File) => {
    try {
      const imported = await readJsonFile(file);
      setProject(normalizeDocumentProject({ ...imported, updatedAt: new Date().toISOString() }));
      setStatusText("JSONを読み込み");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "JSONを読み込めませんでした。");
    }
  };

  const saveToDrive = async () => {
    try {
      if (!isDriveConfigured()) {
        window.alert("Google Drive連携を使うには .env に Google API の設定が必要です。");
        return;
      }

      const client = driveClient ?? (await connectGoogleDrive());
      setDriveClient(client);
      const result = await client.saveProject(project);
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
      await exportProjectPdf(project);
      setStatusText("本用PDFを書き出し");
    } catch (error) {
      setStatusText("PDF書き出しに失敗");
      window.console.error(error);
      window.alert(error instanceof Error ? error.message : "PDFを書き出せませんでした。");
    }
  };

  const exportDocx = async () => {
    try {
      await exportProjectDocx(project);
      setStatusText("DOCXを書き出し");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "DOCXを書き出せませんでした。");
    }
  };

  const addQrLink = (draft: QrDraft, mode: "save" | "insert" = "save") => {
    const name = draft.name.trim();
    const url = draft.url.trim();
    const description = draft.description.trim();
    const category = draft.category.trim() || "公式";

    if (!name || !url) {
      window.alert("リンク名とURLを入力してください。");
      return false;
    }

    if (!isValidUrl(url)) {
      window.alert("http または https のURLを入力してください。");
      return false;
    }

    const link: QrLink = {
      id: crypto.randomUUID(),
      name,
      url,
      description,
      category
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
    const src = await QRCode.toDataURL(link.url, {
      margin: 1,
      width: 420,
      color: { dark: "#24211d", light: "#ffffff" }
    });
    activeEditor
      .chain()
      .focus()
      .insertContent({
        type: "qrCard",
        attrs: {
          url: link.url,
          title: link.name,
          description: link.description,
          src,
          template: "umbrella",
          label: "Umbrella Parade 記録室"
        }
      })
      .run();
    setMobileTab("draft");
  };

  const openQrLibrary = () => {
    setMobileTab("check");
    setStatusText("QRリンクパネルを開きました");
  };

  const resetProject = () => {
    if (!window.confirm("新規原稿を作成しますか？現在のブラウザ保存は上書きされます。")) {
      return;
    }
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
            <span className="chapter-meta">{countManuscriptCharacters(project).toLocaleString("ja-JP")}字</span>
          </div>
          <TiptapToolbar editor={activeEditor} onOpenQrLibrary={openQrLibrary} />
          <div ref={pageStageRef} className="page-stage" onWheel={handlePageStageWheel}>
            <div
              className={`paged-document ${estimatedPages > 1 ? "is-long-manuscript" : ""}`}
              data-estimated-pages={estimatedPages}
              data-rendered-pages={pageFrameCount}
            >
              <div className="page-frame-track" aria-hidden="true">
                {Array.from({ length: pageFrameCount }, (_, pageIndex) => (
                  <section key={pageIndex} className="page-frame">
                    <header className="page-frame-header">
                      <span>{project.title}</span>
                      <span>{activeSectionTitle}</span>
                    </header>
                    {project.pageSettings.showBleedGuide ? <div className="page-bleed-guide" /> : null}
                    {project.pageSettings.showSafeArea ? <div className="page-safe-guide" /> : null}
                    <footer className="page-frame-footer">
                      <span>{project.author}</span>
                      {project.pageSettings.showPageNumber ? <span>{pageIndex + 1}</span> : null}
                    </footer>
                  </section>
                ))}
              </div>
              <div className="paged-editor-layer">
                <TiptapEditor key={activeChapter.id} content={activeChapter.content} onChange={updateActiveChapterContent} onReady={setActiveEditor} />
              </div>
            </div>
          </div>
        </section>

        <aside className={`right-rail mobile-panel ${mobileTab === "check" || mobileTab === "export" ? "is-mobile-active" : ""}`}>
          <CheckPanel project={project} checks={checks} />
          <QrLibraryPanel
            links={project.qrLinks}
            onAdd={addQrLink}
            onInsert={insertQrLink}
            onDelete={(id) => updateProject((previous) => ({ ...previous, qrLinks: previous.qrLinks.filter((link) => link.id !== id) }))}
          />
          <ExportPanel project={project} onJson={exportJson} onPdf={exportPdf} onDocx={exportDocx} onDrive={saveToDrive} />
        </aside>
      </div>
      <PrintDocument project={project} chapter={activeChapter} sectionTitle={activeSectionTitle} pageCount={pageFrameCount} />
    </main>
  );
}

function PrintDocument({
  project,
  chapter,
  sectionTitle,
  pageCount
}: {
  project: ManuscriptProject;
  chapter: Chapter;
  sectionTitle: string;
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
            <span>{project.title}</span>
            <span>{sectionTitle}</span>
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
            <span>{project.author}</span>
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

function CheckPanel({ project, checks }: { project: ManuscriptProject; checks: ReturnType<typeof runManuscriptChecks> }) {
  return (
    <section className="tool-panel">
      <div className="panel-title-row">
        <h2>確認</h2>
        <span className="mini-badge">{estimatePageCount(project)}p</span>
      </div>
      <div className="metric-row">
        <div>
          <span>総文字数</span>
          <strong>{countManuscriptCharacters(project).toLocaleString("ja-JP")}</strong>
        </div>
        <div>
          <span>推定ページ</span>
          <strong>{estimatePageCount(project)}</strong>
        </div>
      </div>
      <div className="check-list">
        {checks.map((check) => (
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
  links,
  onAdd,
  onInsert,
  onDelete
}: {
  links: QrLink[];
  onAdd: (draft: QrDraft, mode?: "save" | "insert") => boolean;
  onInsert: (link: QrLink) => void;
  onDelete: (id: string) => void;
}) {
  const [newQr, setNewQr] = useState<QrDraft>(EMPTY_QR_DRAFT);
  const handleAdd = (mode: "save" | "insert") => {
    if (onAdd(newQr, mode)) {
      setNewQr(EMPTY_QR_DRAFT);
    }
  };

  return (
    <section className="tool-panel">
      <div className="panel-title-row">
        <h2>QRリンク</h2>
      </div>
      <div className="qr-form">
        <input placeholder="リンク名" value={newQr.name} onChange={(event) => setNewQr({ ...newQr, name: event.target.value })} />
        <input placeholder="URL" value={newQr.url} onChange={(event) => setNewQr({ ...newQr, url: event.target.value })} />
        <input placeholder="説明" value={newQr.description} onChange={(event) => setNewQr({ ...newQr, description: event.target.value })} />
        <input placeholder="種別" value={newQr.category} onChange={(event) => setNewQr({ ...newQr, category: event.target.value })} />
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
        {links.map((link) => (
          <div key={link.id} className="qr-link-item">
            <button type="button" title={`${link.name}を本文へ挿入`} aria-label={`${link.name}を本文へ挿入`} onClick={() => void onInsert(link)}>
              <QrCode size={16} />
              <span className="qr-link-text">
                <strong>{link.name}</strong>
                <span>{link.category}</span>
              </span>
            </button>
            <button className="icon-button small danger" type="button" title="削除" aria-label="削除" onClick={() => onDelete(link.id)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExportPanel({
  project,
  onJson,
  onPdf,
  onDocx,
  onDrive
}: {
  project: ManuscriptProject;
  onJson: () => void;
  onPdf: () => void;
  onDocx: () => void;
  onDrive: () => void;
}) {
  return (
    <section className="tool-panel export-panel">
      <div className="panel-title-row">
        <h2>出力</h2>
        <span className="mini-badge">{sanitizeFileName(project.title)}</span>
      </div>
      <div className="export-grid">
        <button type="button" onClick={onJson}>
          <Download size={18} />
          JSON
        </button>
        <button type="button" onClick={onPdf}>
          <FileDown size={18} />
          PDF
        </button>
        <button type="button" onClick={onDocx}>
          <FileText size={18} />
          DOCX
        </button>
        <button type="button" onClick={onDrive}>
          <Upload size={18} />
          Drive
        </button>
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
        background: #fffdf8 !important;
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
        justify-content: space-between;
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
        position: absolute;
        pointer-events: none;
        z-index: 2;
      }

      .print-bleed-guide {
        inset: 3mm;
        border: 1px dashed rgba(183, 132, 66, 0.55);
      }

      .print-safe-guide {
        inset: ${page.marginTopMm}mm ${page.marginRightMm}mm ${page.marginBottomMm}mm ${page.marginLeftMm}mm;
        border: 1px dotted rgba(58, 130, 120, 0.55);
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

      .print-flow .page-break {
        break-after: column;
      }
    }
  `;
}
