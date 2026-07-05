export type PagePresetId = "kindle" | "shimauma-a6" | "shimauma-a5" | "custom";
export type ManuscriptFontId = "noto-serif-jp" | "noto-sans-jp";
export type QrCardTemplateId = "umbrella" | "rain-letter" | "antique-book" | "midnight";
export type TocStyleId = "classic" | "rain" | "antique" | "midnight";

export type PageSettings = {
  preset: PagePresetId;
  fontFamily: ManuscriptFontId;
  pageWidthMm: number;
  pageHeightMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  fontSizePt: number;
  rubySizePt: number;
  lineHeight: number;
  paragraphSpacingMm: number;
  imageMaxHeightMm: number;
  showPageNumber: boolean;
  showBleedGuide: boolean;
  showSafeArea: boolean;
};

export type Chapter = {
  id: string;
  title: string;
  content: string;
};

export type QrLink = {
  id: string;
  name: string;
  url: string;
  description: string;
  category: string;
  template?: QrCardTemplateId;
};

export type DriveState = {
  fileId?: string;
  lastSavedAt?: string;
  folderId?: string;
  folderName?: string;
};

export type TocSettings = {
  title: string;
  subtitle: string;
  style: TocStyleId;
  /** 目次本文のフォントサイズ（pt）。省略時は原稿フォントサイズに準じる */
  fontSizePt?: number;
  /** 目次タイトルと項目一覧の間隔（pt）。 */
  titleGapPt?: number;
};

export type ManuscriptProject = {
  schemaVersion: 1;
  id: string;
  title: string;
  subtitle: string;
  author: string;
  pageSettings: PageSettings;
  chapters: Chapter[];
  activeChapterId: string;
  qrLinks: QrLink[];
  tocSettings: TocSettings;
  drive?: DriveState;
  updatedAt: string;
};

export type CheckLevel = "ok" | "warning" | "danger";

export type ManuscriptCheck = {
  id: string;
  label: string;
  detail: string;
  level: CheckLevel;
};
