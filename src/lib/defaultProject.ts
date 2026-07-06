import type { DriveState, ManuscriptCheck, ManuscriptFontId, ManuscriptProject, PagePresetId, PageSettings, QrCardTemplateId, TocSettings, TocStyleId } from "./types";

export const MANUSCRIPT_FONTS: Record<ManuscriptFontId, { label: string; css: string }> = {
  "noto-serif-jp": {
    label: "Noto Serif JP",
    css: "\"Noto Serif JP\", \"Yu Mincho\", \"Hiragino Mincho ProN\", serif"
  },
  "noto-sans-jp": {
    label: "Noto Sans JP",
    css: "\"Noto Sans JP\", \"Yu Gothic UI\", \"Meiryo\", sans-serif"
  }
};

export const PAGE_PRESETS: Record<PagePresetId, { label: string; settings: PageSettings }> = {
  kindle: {
    label: "Kindle",
    settings: {
      preset: "kindle",
      fontFamily: "noto-serif-jp",
      pageWidthMm: 148,
      pageHeightMm: 210,
      marginTopMm: 18,
      marginBottomMm: 18,
      marginLeftMm: 18,
      marginRightMm: 18,
      fontSizePt: 11,
      rubySizePt: 6,
      lineHeight: 1.75,
      paragraphSpacingMm: 1.5,
      imageMaxHeightMm: 120,
      showPageNumber: false,
      showBleedGuide: false,
      showSafeArea: false
    }
  },
  "shimauma-a6": {
    label: "しまうまA6塗り足し版",
    settings: {
      preset: "shimauma-a6",
      fontFamily: "noto-serif-jp",
      pageWidthMm: 111,
      pageHeightMm: 154,
      marginTopMm: 13,
      marginBottomMm: 15,
      marginLeftMm: 12,
      marginRightMm: 12,
      fontSizePt: 8.8,
      rubySizePt: 4.6,
      lineHeight: 1.72,
      paragraphSpacingMm: 1,
      imageMaxHeightMm: 74,
      showPageNumber: true,
      showBleedGuide: true,
      showSafeArea: true
    }
  },
  "shimauma-a5": {
    label: "しまうまA5塗り足し版",
    settings: {
      preset: "shimauma-a5",
      fontFamily: "noto-serif-jp",
      pageWidthMm: 154,
      pageHeightMm: 216,
      marginTopMm: 16,
      marginBottomMm: 18,
      marginLeftMm: 15,
      marginRightMm: 15,
      fontSizePt: 10,
      rubySizePt: 5.2,
      lineHeight: 1.76,
      paragraphSpacingMm: 1.2,
      imageMaxHeightMm: 120,
      showPageNumber: true,
      showBleedGuide: true,
      showSafeArea: true
    }
  },
  custom: {
    label: "カスタム",
    settings: {
      preset: "custom",
      fontFamily: "noto-serif-jp",
      pageWidthMm: 105,
      pageHeightMm: 148,
      marginTopMm: 10,
      marginBottomMm: 12,
      marginLeftMm: 9,
      marginRightMm: 9,
      fontSizePt: 9,
      rubySizePt: 4.8,
      lineHeight: 1.7,
      paragraphSpacingMm: 1,
      imageMaxHeightMm: 74,
      showPageNumber: true,
      showBleedGuide: true,
      showSafeArea: true
    }
  }
};

const QR_CARD_TEMPLATE_IDS = new Set<QrCardTemplateId>(["umbrella", "rain-letter", "antique-book", "midnight"]);
const TOC_STYLE_IDS = new Set<TocStyleId>(["classic", "rain", "antique", "midnight"]);

export const DEFAULT_TOC_SETTINGS: TocSettings = {
  title: "目次",
  subtitle: "",
  style: "classic",
  titleGapPt: 18
};

const sampleContent = `
<h1>第一章：雨の記憶</h1>
<p>雨音が窓の縁をなぞる夜、主人公は古いノートを開いた。そこには、まだ名前のない町と、まだ会ったことのない誰かへの手紙が残されていた。</p>
<p>「ここから、物語を始めよう」</p>
<p>このエディタでは本文を見たまま整えながら、ページ設定に合わせた原稿を作れます。</p>
`.trim();

export function createDefaultProject(): ManuscriptProject {
  const now = new Date().toISOString();
  const firstChapterId = crypto.randomUUID();

  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    title: "Umbrella Parade 原稿",
    subtitle: "雨の中で踊る、未完成の物語",
    author: "Umbrella Parade",
    pageSettings: { ...PAGE_PRESETS["shimauma-a6"].settings },
    chapters: [
      {
        id: firstChapterId,
        title: "本文",
        content: sampleContent
      }
    ],
    activeChapterId: firstChapterId,
    tocSettings: { ...DEFAULT_TOC_SETTINGS },
    qrLinks: [
      {
        id: crypto.randomUUID(),
        name: "Umbrella Parade 公式サイト",
        url: "https://example.com",
        description: "作品情報やお知らせへのリンク",
        category: "公式",
        template: "umbrella"
      }
    ],
    updatedAt: now
  };
}

export function applyPreset(settings: PageSettings, preset: PagePresetId): PageSettings {
  if (preset === "custom") {
    return normalizePageSettings({ ...settings, preset: "custom" });
  }

  return normalizePageSettings({ ...PAGE_PRESETS[preset].settings });
}

export function normalizeProject(project: ManuscriptProject): ManuscriptProject {
  return {
    ...project,
    pageSettings: normalizePageSettings(project.pageSettings),
    tocSettings: normalizeTocSettings(project.tocSettings),
    drive: normalizeDriveState(project.drive),
    qrLinks: (project.qrLinks ?? []).map((link) => ({
      ...link,
      template: QR_CARD_TEMPLATE_IDS.has(link.template ?? "umbrella") ? link.template ?? "umbrella" : "umbrella"
    }))
  };
}

function normalizeDriveState(state?: Partial<DriveState>): DriveState | undefined {
  if (!state) {
    return undefined;
  }

  const drive: DriveState = {};
  if (typeof state.fileId === "string" && state.fileId.trim()) {
    drive.fileId = state.fileId.trim();
  }
  if (typeof state.lastSavedAt === "string" && state.lastSavedAt.trim()) {
    drive.lastSavedAt = state.lastSavedAt.trim();
  }
  if (typeof state.folderId === "string" && state.folderId.trim()) {
    drive.folderId = state.folderId.trim();
  }
  if (typeof state.folderName === "string" && state.folderName.trim()) {
    drive.folderName = state.folderName.trim();
  }

  return Object.keys(drive).length ? drive : undefined;
}

export function normalizeTocSettings(settings?: Partial<TocSettings>): TocSettings {
  const fontSizePt = typeof settings?.fontSizePt === "number" && Number.isFinite(settings.fontSizePt) && settings.fontSizePt > 0 ? settings.fontSizePt : undefined;
  const titleGapPt = typeof settings?.titleGapPt === "number" && Number.isFinite(settings.titleGapPt) && settings.titleGapPt >= 0
    ? Math.max(0, Math.min(48, Number(settings.titleGapPt.toFixed(1))))
    : DEFAULT_TOC_SETTINGS.titleGapPt;

  return {
    title: settings?.title?.trim() || DEFAULT_TOC_SETTINGS.title,
    subtitle: "",
    style: TOC_STYLE_IDS.has(settings?.style ?? "classic") ? settings?.style ?? "classic" : DEFAULT_TOC_SETTINGS.style,
    ...(fontSizePt ? { fontSizePt } : {}),
    titleGapPt
  };
}

export function normalizePageSettings(settings: PageSettings): PageSettings {
  const presetDefaults = PAGE_PRESETS[settings.preset]?.settings ?? PAGE_PRESETS["shimauma-a6"].settings;
  const fontFamily = Object.hasOwn(MANUSCRIPT_FONTS, settings.fontFamily) ? settings.fontFamily : presetDefaults.fontFamily;
  const normalized = {
    ...presetDefaults,
    ...settings,
    fontFamily,
    imageMaxHeightMm: settings.imageMaxHeightMm ?? presetDefaults.imageMaxHeightMm
  };

  return migrateShimaumaBleedSettings(normalized);
}

function migrateShimaumaBleedSettings(settings: PageSettings): PageSettings {
  if (settings.preset === "shimauma-a6" && settings.pageWidthMm === 105 && settings.pageHeightMm === 148) {
    return {
      ...settings,
      pageWidthMm: 111,
      pageHeightMm: 154,
      marginTopMm: settings.marginTopMm + 3,
      marginBottomMm: settings.marginBottomMm + 3,
      marginLeftMm: settings.marginLeftMm + 3,
      marginRightMm: settings.marginRightMm + 3,
      showBleedGuide: true,
      showSafeArea: true
    };
  }

  if (settings.preset === "shimauma-a5" && settings.pageWidthMm === 148 && settings.pageHeightMm === 210) {
    return {
      ...settings,
      pageWidthMm: 154,
      pageHeightMm: 216,
      marginTopMm: settings.marginTopMm + 3,
      marginBottomMm: settings.marginBottomMm + 3,
      marginLeftMm: settings.marginLeftMm + 3,
      marginRightMm: settings.marginRightMm + 3,
      showBleedGuide: true,
      showSafeArea: true
    };
  }

  return settings;
}

export function stripHtml(html: string): string {
  if (typeof window === "undefined") {
    return html.replace(/<[^>]*>/g, " ");
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("rt").forEach((rt) => {
    rt.replaceWith(`(${rt.textContent ?? ""})`);
  });
  return template.content.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export function countManuscriptCharacters(project: ManuscriptProject): number {
  return project.chapters
    .map((chapter) => stripHtml(chapter.content))
    .join("")
    .replace(/\s/g, "").length;
}

export function estimatePageCount(project: ManuscriptProject): number {
  const settings = project.pageSettings;
  const textWidthMm = Math.max(20, settings.pageWidthMm - settings.marginLeftMm - settings.marginRightMm);
  const textHeightMm = Math.max(30, settings.pageHeightMm - settings.marginTopMm - settings.marginBottomMm);
  const fontMm = settings.fontSizePt * 0.352778;
  const charsPerLine = Math.max(12, Math.floor(textWidthMm / fontMm));
  const linesPerPage = Math.max(8, Math.floor(textHeightMm / (fontMm * settings.lineHeight)));
  const charsPerPage = charsPerLine * linesPerPage;
  const characters = countManuscriptCharacters(project);
  const blockCount = (project.chapters.map((chapter) => chapter.content).join("").match(/data-type="qr-card"|<img/gi) ?? []).length;
  const chapterBreakPages = Math.max(0, project.chapters.length - 1);

  return Math.max(1, Math.ceil(characters / charsPerPage + blockCount * 0.45 + chapterBreakPages * 0.35));
}

export function runManuscriptChecks(project: ManuscriptProject): ManuscriptCheck[] {
  const checks: ManuscriptCheck[] = [];
  const charCount = countManuscriptCharacters(project);
  const html = project.chapters.map((chapter) => chapter.content).join("\n");
  const qrCount = (html.match(/data-type="qr-card"/g) ?? []).length;
  const imageCount = (html.match(/<img/g) ?? []).length - qrCount;
  const headingCount = (html.match(/<h1\b/gi) ?? []).length;
  const hasEmptyChapter = project.chapters.some((chapter) => stripHtml(chapter.content).length === 0);
  const unsafeQr = [...html.matchAll(/data-url="([^"]*)"/g)].some((match) => !isValidUrl(match[1]));

  checks.push({
    id: "characters",
    label: "文字数",
    detail: `${charCount.toLocaleString("ja-JP")}字 / 推定${estimatePageCount(project)}ページ`,
    level: "ok"
  });

  checks.push({
    id: "headings",
    label: "H1見出し",
    detail: hasEmptyChapter ? "本文が空です" : `${headingCount}件`,
    level: hasEmptyChapter || headingCount === 0 ? "warning" : "ok"
  });

  checks.push({
    id: "media",
    label: "画像・QR",
    detail: `画像${Math.max(0, imageCount)}点 / QR${qrCount}点`,
    level: "ok"
  });

  checks.push({
    id: "qr",
    label: "QRリンク",
    detail: unsafeQr ? "URL形式を確認してください" : "URL形式OK",
    level: unsafeQr ? "danger" : "ok"
  });

  checks.push({
    id: "page",
    label: "紙面",
    detail: `${project.pageSettings.pageWidthMm}mm x ${project.pageSettings.pageHeightMm}mm`,
    level: project.pageSettings.pageWidthMm < 80 || project.pageSettings.pageHeightMm < 100 ? "warning" : "ok"
  });

  return checks;
}

export function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function sanitizeFileName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "manuscript";
}
