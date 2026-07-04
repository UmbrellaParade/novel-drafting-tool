"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import QRCode from "qrcode";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cloud,
  Download,
  FileDown,
  FileJson,
  FileText,
  FolderOpen,
  Plus,
  Printer,
  Save,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";
import { TiptapEditor } from "./TiptapEditor";
import { PAGE_PRESETS, applyPreset, countManuscriptCharacters, createDefaultProject, estimatePageCount, runManuscriptChecks, sanitizeFileName } from "@/lib/defaultProject";
import type { Chapter, ManuscriptProject, PagePresetId, QrLink } from "@/lib/types";
import { exportProjectJson, loadProjectFromBrowser, readJsonFile, saveProjectToBrowser } from "@/lib/storage";
import { connectGoogleDrive, isDriveConfigured } from "@/lib/googleDrive";
import { exportProjectDocx } from "@/lib/exporters";

type MobileTab = "draft" | "chapters" | "check" | "export";

type DriveClient = Awaited<ReturnType<typeof connectGoogleDrive>>;

const tabLabels: Record<MobileTab, string> = {
  draft: "本文",
  chapters: "章",
  check: "確認",
  export: "出力"
};

export function EditorShell() {
  const [project, setProject] = useState<ManuscriptProject | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("draft");
  const [statusText, setStatusText] = useState("起動中");
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [driveClient, setDriveClient] = useState<DriveClient | null>(null);
  const [newQr, setNewQr] = useState({ name: "", url: "", description: "", category: "公式" });
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const restored = loadProjectFromBrowser();
    setProject(restored ?? createDefaultProject());
    setStatusText(restored ? "ブラウザ保存から復元" : "新規原稿");
  }, []);

  useEffect(() => {
    if (!project) {
      return;
    }

    const handle = window.setTimeout(() => {
      saveProjectToBrowser(project);
      setStatusText(`ブラウザ保存 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`);
    }, 500);

    return () => window.clearTimeout(handle);
  }, [project]);

  const activeChapter = useMemo(() => {
    if (!project) {
      return null;
    }
    return project.chapters.find((chapter) => chapter.id === project.activeChapterId) ?? project.chapters[0] ?? null;
  }, [project]);

  const checks = useMemo(() => (project ? runManuscriptChecks(project) : []), [project]);
  const estimatedPages = useMemo(() => (project ? estimatePageCount(project) : 1), [project]);
  const pageFrameCount = Math.max(1, Math.min(estimatedPages, 80));

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
      updateProject((previous) => ({
        ...previous,
        chapters: previous.chapters.map((chapter) =>
          chapter.id === previous.activeChapterId ? { ...chapter, content } : chapter
        )
      }));
    },
    [updateProject]
  );

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
    "--manuscript-font-size": `${project.pageSettings.fontSizePt}pt`,
    "--ruby-font-size": `${project.pageSettings.rubySizePt}pt`,
    "--line-height": project.pageSettings.lineHeight,
    "--paragraph-spacing": `${project.pageSettings.paragraphSpacingMm}mm`,
    "--page-gap": "14mm",
    "--content-width": "calc(var(--page-width) - var(--margin-left) - var(--margin-right))",
    "--content-height": "calc(var(--page-height) - var(--margin-top) - var(--margin-bottom))",
    "--column-gap": "calc(var(--margin-left) + var(--margin-right) + var(--page-gap))",
    "--paged-track-width": `calc(${pageFrameCount} * var(--page-width) + ${pageFrameCount - 1} * var(--page-gap))`,
    "--paged-content-width": `calc(${pageFrameCount} * (var(--page-width) - var(--margin-left) - var(--margin-right)) + ${pageFrameCount - 1} * (var(--margin-left) + var(--margin-right) + var(--page-gap)))`
  } as React.CSSProperties;

  const setActiveChapter = (chapterId: string) => {
    updateProject((previous) => ({ ...previous, activeChapterId: chapterId }));
    setMobileTab("draft");
  };

  const addChapter = () => {
    const id = crypto.randomUUID();
    const chapter: Chapter = {
      id,
      title: `第${project.chapters.length + 1}章`,
      content: "<p></p>"
    };
    updateProject((previous) => ({
      ...previous,
      chapters: [...previous.chapters, chapter],
      activeChapterId: id
    }));
    setMobileTab("draft");
  };

  const deleteChapter = (chapterId: string) => {
    if (project.chapters.length === 1) {
      window.alert("章は1つ以上必要です。");
      return;
    }
    if (!window.confirm("この章を削除しますか？")) {
      return;
    }

    updateProject((previous) => {
      const chapters = previous.chapters.filter((chapter) => chapter.id !== chapterId);
      return {
        ...previous,
        chapters,
        activeChapterId: chapters[0].id
      };
    });
  };

  const moveChapter = (chapterId: string, direction: -1 | 1) => {
    updateProject((previous) => {
      const index = previous.chapters.findIndex((chapter) => chapter.id === chapterId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= previous.chapters.length) {
        return previous;
      }
      const chapters = [...previous.chapters];
      const [chapter] = chapters.splice(index, 1);
      chapters.splice(nextIndex, 0, chapter);
      return { ...previous, chapters };
    });
  };

  const updateChapterTitle = (chapterId: string, title: string) => {
    updateProject((previous) => ({
      ...previous,
      chapters: previous.chapters.map((chapter) => (chapter.id === chapterId ? { ...chapter, title } : chapter))
    }));
  };

  const handlePreset = (preset: PagePresetId) => {
    updateProject((previous) => ({
      ...previous,
      pageSettings: applyPreset(previous.pageSettings, preset)
    }));
  };

  const updatePageNumber = (key: keyof ManuscriptProject["pageSettings"], value: number | boolean) => {
    updateProject((previous) => ({
      ...previous,
      pageSettings: {
        ...previous.pageSettings,
        preset: key === "preset" ? previous.pageSettings.preset : previous.pageSettings.preset,
        [key]: value
      }
    }));
  };

  const exportJson = () => {
    exportProjectJson(project);
    setStatusText("JSONを書き出し");
  };

  const manualSave = () => {
    saveProjectToBrowser(project);
    setStatusText(`ブラウザ保存 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`);
  };

  const importJson = async (file: File) => {
    try {
      const imported = await readJsonFile(file);
      setProject({ ...imported, updatedAt: new Date().toISOString() });
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

  const printPdf = () => {
    setMobileTab("draft");
    window.setTimeout(() => window.print(), 80);
  };

  const exportDocx = async () => {
    try {
      await exportProjectDocx(project);
      setStatusText("DOCXを書き出し");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "DOCXを書き出せませんでした。");
    }
  };

  const addQrLink = () => {
    if (!newQr.name.trim() || !newQr.url.trim()) {
      window.alert("リンク名とURLを入力してください。");
      return;
    }

    const link: QrLink = {
      id: crypto.randomUUID(),
      name: newQr.name.trim(),
      url: newQr.url.trim(),
      description: newQr.description.trim(),
      category: newQr.category.trim() || "公式"
    };
    updateProject((previous) => ({
      ...previous,
      qrLinks: [...previous.qrLinks, link]
    }));
    setNewQr({ name: "", url: "", description: "", category: "公式" });
  };

  const insertQrLink = async (link: QrLink) => {
    if (!activeEditor) {
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

  const resetProject = () => {
    if (!window.confirm("新規原稿を作成しますか？現在のブラウザ保存は上書きされます。")) {
      return;
    }
    setProject(createDefaultProject());
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
          <button className="command-button" type="button" onClick={printPdf} title="PDF出力">
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
          <ProjectPanel
            project={project}
            onProjectChange={updateProject}
            onPreset={handlePreset}
            onPageChange={updatePageNumber}
            onReset={resetProject}
          />
          <ChapterPanel
            chapters={project.chapters}
            activeChapterId={project.activeChapterId}
            onAdd={addChapter}
            onDelete={deleteChapter}
            onMove={moveChapter}
            onSelect={setActiveChapter}
            onTitleChange={updateChapterTitle}
          />
        </aside>

        <section className={`editor-column mobile-panel ${mobileTab === "draft" ? "is-mobile-active" : ""}`} aria-label="本文編集">
          <div className="chapter-heading-row">
            <input
              className="chapter-title-input"
              value={activeChapter.title}
              onChange={(event) => updateChapterTitle(activeChapter.id, event.target.value)}
              aria-label="章タイトル"
            />
            <span className="chapter-meta">{countManuscriptCharacters({ ...project, chapters: [activeChapter] }).toLocaleString("ja-JP")}字</span>
          </div>
          <div className="page-stage">
            <div
              className={`paged-document ${estimatedPages > 1 ? "is-long-manuscript" : ""}`}
              data-estimated-pages={estimatedPages}
            >
              <div className="page-frame-track" aria-hidden="true">
                {Array.from({ length: pageFrameCount }, (_, pageIndex) => (
                  <section key={pageIndex} className="page-frame">
                    <header className="page-frame-header">
                      <span>{project.title}</span>
                      <span>{activeChapter.title}</span>
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
            newQr={newQr}
            onNewQrChange={setNewQr}
            onAdd={addQrLink}
            onInsert={insertQrLink}
            onDelete={(id) => updateProject((previous) => ({ ...previous, qrLinks: previous.qrLinks.filter((link) => link.id !== id) }))}
          />
          <ExportPanel project={project} onJson={exportJson} onPdf={printPdf} onDocx={exportDocx} onDrive={saveToDrive} />
        </aside>
      </div>
    </main>
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
  onPageChange: (key: keyof ManuscriptProject["pageSettings"], value: number | boolean) => void;
  onReset: () => void;
}) {
  const settings = project.pageSettings;
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
        <NumberField label="行間" value={settings.lineHeight} step={0.05} onChange={(value) => onPageChange("lineHeight", value)} />
        <NumberField label="段落mm" value={settings.paragraphSpacingMm} step={0.1} onChange={(value) => onPageChange("paragraphSpacingMm", value)} />
      </div>

      <div className="toggle-row">
        <label><input type="checkbox" checked={settings.showPageNumber} onChange={(event) => onPageChange("showPageNumber", event.target.checked)} /> ページ番号</label>
        <label><input type="checkbox" checked={settings.showBleedGuide} onChange={(event) => onPageChange("showBleedGuide", event.target.checked)} /> 塗り足し</label>
        <label><input type="checkbox" checked={settings.showSafeArea} onChange={(event) => onPageChange("showSafeArea", event.target.checked)} /> 安全域</label>
      </div>
    </section>
  );
}

function ChapterPanel({
  chapters,
  activeChapterId,
  onAdd,
  onDelete,
  onMove,
  onSelect,
  onTitleChange
}: {
  chapters: Chapter[];
  activeChapterId: string;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onSelect: (id: string) => void;
  onTitleChange: (id: string, title: string) => void;
}) {
  return (
    <section className="tool-panel">
      <div className="panel-title-row">
        <h2>章</h2>
        <button className="icon-button" type="button" title="章を追加" aria-label="章を追加" onClick={onAdd}>
          <Plus size={17} />
        </button>
      </div>
      <div className="chapter-list">
        {chapters.map((chapter, index) => (
          <div key={chapter.id} className={`chapter-item ${chapter.id === activeChapterId ? "is-active" : ""}`}>
            <button className="chapter-select" type="button" onClick={() => onSelect(chapter.id)}>
              <span>{String(index + 1).padStart(2, "0")}</span>
            </button>
            <input value={chapter.title} onChange={(event) => onTitleChange(chapter.id, event.target.value)} aria-label="章タイトル" />
            <button className="icon-button small" type="button" title="上へ" aria-label="上へ" onClick={() => onMove(chapter.id, -1)}>
              <ArrowUp size={15} />
            </button>
            <button className="icon-button small" type="button" title="下へ" aria-label="下へ" onClick={() => onMove(chapter.id, 1)}>
              <ArrowDown size={15} />
            </button>
            <button className="icon-button small danger" type="button" title="削除" aria-label="削除" onClick={() => onDelete(chapter.id)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
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
  newQr,
  onNewQrChange,
  onAdd,
  onInsert,
  onDelete
}: {
  links: QrLink[];
  newQr: { name: string; url: string; description: string; category: string };
  onNewQrChange: (value: { name: string; url: string; description: string; category: string }) => void;
  onAdd: () => void;
  onInsert: (link: QrLink) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="tool-panel">
      <div className="panel-title-row">
        <h2>QRリンク</h2>
        <button className="icon-button" type="button" title="追加" aria-label="追加" onClick={onAdd}>
          <Plus size={17} />
        </button>
      </div>
      <div className="qr-form">
        <input placeholder="リンク名" value={newQr.name} onChange={(event) => onNewQrChange({ ...newQr, name: event.target.value })} />
        <input placeholder="URL" value={newQr.url} onChange={(event) => onNewQrChange({ ...newQr, url: event.target.value })} />
        <input placeholder="説明" value={newQr.description} onChange={(event) => onNewQrChange({ ...newQr, description: event.target.value })} />
        <input placeholder="種別" value={newQr.category} onChange={(event) => onNewQrChange({ ...newQr, category: event.target.value })} />
      </div>
      <div className="qr-list">
        {links.map((link) => (
          <div key={link.id} className="qr-link-item">
            <button type="button" onClick={() => void onInsert(link)}>
              <strong>{link.name}</strong>
              <span>{link.category}</span>
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
    @media print {
      @page {
        size: ${page.pageWidthMm}mm ${page.pageHeightMm}mm;
        margin: 0;
      }

      body {
        background: #ffffff !important;
      }

      .topbar,
      .mobile-tabs,
      .left-rail,
      .right-rail,
      .chapter-heading-row,
      .editor-toolbar {
        display: none !important;
      }

      .app-shell,
      .workspace-grid,
      .editor-column,
      .page-stage {
        display: block !important;
        background: #ffffff !important;
        padding: 0 !important;
        margin: 0 !important;
        border: 0 !important;
        box-shadow: none !important;
        width: auto !important;
        height: auto !important;
        overflow: visible !important;
      }

      .paged-document {
        margin: 0 !important;
        width: var(--paged-track-width) !important;
        min-height: ${page.pageHeightMm}mm !important;
      }

      .page-frame {
        box-shadow: none !important;
        border-color: rgba(36, 33, 29, 0.18) !important;
        width: ${page.pageWidthMm}mm !important;
        height: ${page.pageHeightMm}mm !important;
      }

      .paged-editor-layer {
        top: ${page.marginTopMm}mm !important;
        left: ${page.marginLeftMm}mm !important;
      }

      .manuscript-prose {
        height: calc(${page.pageHeightMm}mm - ${page.marginTopMm}mm - ${page.marginBottomMm}mm) !important;
      }
    }
  `;
}
