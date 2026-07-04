export type PagePresetId = "kindle" | "shimauma-a6" | "shimauma-a5" | "custom";

export type PageSettings = {
  preset: PagePresetId;
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
};

export type DriveState = {
  fileId?: string;
  lastSavedAt?: string;
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
