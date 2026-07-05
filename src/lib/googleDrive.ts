import type { ManuscriptProject } from "./types";
import { sanitizeFileName } from "./defaultProject";

declare global {
  interface Window {
    gapi?: GoogleApi;
    google?: GoogleIdentity;
  }
}

const DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_METADATA_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const REQUIRED_SCOPES = [DRIVE_FILE_SCOPE, DRIVE_METADATA_READONLY_SCOPE];
const SCOPES = REQUIRED_SCOPES.join(" ");
const DRIVE_SETTINGS_STORAGE_KEY = "umbrella-parade:google-drive-settings";
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export type GoogleDriveSettings = {
  clientId: string;
  apiKey: string;
};

export type DriveFolder = {
  id: string;
  name: string;
};

type TokenResponse = {
  error?: string;
  error_description?: string;
  access_token?: string;
  scope?: string;
};

type TokenClient = {
  callback: (response: TokenResponse) => void;
  requestAccessToken: (options: { prompt: "" | "consent" }) => void;
};

type GoogleApi = {
  load: (library: string, callback: () => void) => void;
  client: {
    init: (config: { apiKey?: string; discoveryDocs: string[] }) => Promise<void>;
    request: <T = { id: string }>(request: {
      path: string;
      method?: "GET" | "POST" | "PATCH";
      params?: Record<string, string | number | boolean | undefined>;
      headers?: Record<string, string>;
      body?: string;
    }) => Promise<{ result: T }>;
    getToken?: () => { access_token?: string; scope?: string } | null;
  };
};

type GoogleIdentity = {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id?: string;
        scope: string;
        callback: (response: TokenResponse) => void;
      }) => TokenClient;
    };
  };
};

type DriveClient = {
  saveProject: (project: ManuscriptProject, folderId?: string) => Promise<{ fileId: string; savedAt: string; folderId?: string }>;
  listFolders: () => Promise<DriveFolder[]>;
  createFolder: (name: string) => Promise<DriveFolder>;
};

let tokenClient: TokenClient | null;
let initialized = false;
let initializedFor = "";

export function isDriveConfigured(): boolean {
  const settings = loadGoogleDriveSettings();
  return Boolean(settings.clientId && settings.apiKey);
}

export function hasBundledGoogleDriveSettings(): boolean {
  const settings = readGoogleDriveEnvSettings();
  return Boolean(settings.clientId && settings.apiKey);
}

export function loadGoogleDriveSettings(): GoogleDriveSettings {
  const envSettings = readGoogleDriveEnvSettings();
  if (typeof window === "undefined") {
    return envSettings;
  }

  if (envSettings.clientId && envSettings.apiKey) {
    return envSettings;
  }

  try {
    const saved = window.localStorage.getItem(DRIVE_SETTINGS_STORAGE_KEY);
    if (!saved) {
      return envSettings;
    }

    const parsed = JSON.parse(saved) as Partial<GoogleDriveSettings>;
    return {
      clientId: typeof parsed.clientId === "string" && parsed.clientId.trim() ? parsed.clientId.trim() : envSettings.clientId,
      apiKey: typeof parsed.apiKey === "string" && parsed.apiKey.trim() ? parsed.apiKey.trim() : envSettings.apiKey
    };
  } catch {
    return envSettings;
  }
}

export function saveGoogleDriveSettings(settings: GoogleDriveSettings): GoogleDriveSettings {
  const normalized = {
    clientId: settings.clientId.trim(),
    apiKey: settings.apiKey.trim()
  };

  if (typeof window !== "undefined") {
    window.localStorage.setItem(DRIVE_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  }

  resetGoogleDriveClient();
  return normalized;
}

export function clearGoogleDriveSettings(): void {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(DRIVE_SETTINGS_STORAGE_KEY);
  }
  resetGoogleDriveClient();
}

export function resetGoogleDriveClient(): void {
  tokenClient = null;
  initialized = false;
  initializedFor = "";
}

export async function connectGoogleDrive(): Promise<DriveClient> {
  const settings = loadGoogleDriveSettings();
  if (!settings.clientId || !settings.apiKey) {
    throw new Error("Google Drive設定にクライアントIDとAPIキーを入力してください。");
  }

  await loadScript("https://apis.google.com/js/api.js");
  await loadScript("https://accounts.google.com/gsi/client");
  await initializeGoogleClients(settings);
  await requestAccessToken();

  return {
    saveProject,
    listFolders,
    createFolder
  };
}

async function initializeGoogleClients(settings: GoogleDriveSettings): Promise<void> {
  const settingsSignature = `${settings.clientId}:${settings.apiKey}:${SCOPES}`;
  if (initialized && initializedFor === settingsSignature) {
    return;
  }

  if (!window.gapi || !window.google) {
    throw new Error("Google APIを読み込めませんでした。");
  }

  await new Promise<void>((resolve) => window.gapi?.load("client", resolve));
  await window.gapi.client.init({
    apiKey: settings.apiKey,
    discoveryDocs: [DISCOVERY_DOC]
  });

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope: SCOPES,
    callback: () => undefined
  });

  initialized = true;
  initializedFor = settingsSignature;
}

function requestAccessToken(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error("Google認証を初期化できませんでした。"));
      return;
    }
    tokenClient.callback = (response: TokenResponse) => {
      if (response.error) {
        reject(new Error(response.error_description || response.error));
        return;
      }
      const grantedScope = response.scope ?? window.gapi?.client.getToken?.()?.scope ?? "";
      if (grantedScope && !hasRequiredScopes(grantedScope)) {
        reject(new Error(`Google Driveの権限が不足しています。OAuth同意画面に ${DRIVE_METADATA_READONLY_SCOPE} を追加してから、もう一度Drive接続してください。`));
        return;
      }
      resolve();
    };
    const hasToken = Boolean(window.gapi?.client.getToken?.()?.access_token);
    tokenClient.requestAccessToken({ prompt: hasToken ? "" : "consent" });
  });
}

function hasRequiredScopes(scopeText: string): boolean {
  const granted = new Set(scopeText.split(/\s+/).filter(Boolean));
  return REQUIRED_SCOPES.every((scope) => granted.has(scope));
}

async function saveProject(project: ManuscriptProject, folderId = project.drive?.folderId): Promise<{ fileId: string; savedAt: string; folderId?: string }> {
  if (!window.gapi) {
    throw new Error("Google APIを読み込めませんでした。");
  }

  const targetFolderId = folderId?.trim() ?? "";
  const canUpdateExistingFile = (project.drive?.folderId ?? "") === targetFolderId;
  const existingFileId = canUpdateExistingFile ? project.drive?.fileId : undefined;
  const metadata: { name: string; mimeType: string; parents?: string[] } = {
    name: `${sanitizeFileName(project.title)}.json`,
    mimeType: "application/json"
  };
  if (targetFolderId && !existingFileId) {
    metadata.parents = [targetFolderId];
  }

  const boundary = `drafting-tool-${Date.now()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(project, null, 2),
    `--${boundary}--`
  ].join("\r\n");

  const response = await window.gapi.client.request<{ id: string }>({
    path: existingFileId ? `/upload/drive/v3/files/${existingFileId}` : "/upload/drive/v3/files",
    method: existingFileId ? "PATCH" : "POST",
    params: { uploadType: "multipart", supportsAllDrives: true },
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body
  });

  return {
    fileId: response.result.id,
    savedAt: new Date().toISOString(),
    ...(targetFolderId ? { folderId: targetFolderId } : {})
  };
}

async function listFolders(): Promise<DriveFolder[]> {
  if (!window.gapi) {
    throw new Error("Google APIを読み込めませんでした。");
  }

  try {
    const folders: DriveFolder[] = [];
    let pageToken: string | undefined;

    do {
      const response = await window.gapi.client.request<{ files?: DriveFolder[]; nextPageToken?: string }>({
        path: "/drive/v3/files",
        method: "GET",
        params: {
          q: `mimeType='${DRIVE_FOLDER_MIME_TYPE}' and trashed=false`,
          fields: "nextPageToken,files(id,name)",
          orderBy: "name_natural",
          pageSize: 100,
          spaces: "drive",
          corpora: "user",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          ...(pageToken ? { pageToken } : {})
        }
      });

      folders.push(...(response.result.files ?? []).filter((folder) => folder.id && folder.name));
      pageToken = response.result.nextPageToken;
    } while (pageToken);

    return folders;
  } catch (error) {
    throw new Error(buildDriveFolderListErrorMessage(error));
  }
}

async function createFolder(name: string): Promise<DriveFolder> {
  if (!window.gapi) {
    throw new Error("Google APIを読み込めませんでした。");
  }

  const folderName = name.trim();
  if (!folderName) {
    throw new Error("フォルダ名を入力してください。");
  }

  const response = await window.gapi.client.request<DriveFolder>({
    path: "/drive/v3/files",
    method: "POST",
    params: { fields: "id,name", supportsAllDrives: true },
    headers: {
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: DRIVE_FOLDER_MIME_TYPE
    })
  });

  return {
    id: response.result.id,
    name: response.result.name || folderName
  };
}

function buildDriveFolderListErrorMessage(error: unknown): string {
  const detail = googleApiErrorDetail(error);
  if (/insufficient|scope|permission|forbidden|403/i.test(detail)) {
    return `Driveフォルダ一覧を取得できませんでした。Google CloudのOAuth同意画面に ${DRIVE_METADATA_READONLY_SCOPE} を追加し、アプリを再読み込みしてDrive接続をやり直してください。${detail ? ` (${detail})` : ""}`;
  }

  return `Driveフォルダ一覧を取得できませんでした。${detail ? ` (${detail})` : ""}`;
}

function googleApiErrorDetail(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (!error || typeof error !== "object") {
    return "";
  }

  const record = error as {
    status?: number;
    body?: string;
    result?: { error?: { message?: string; status?: string; code?: number } };
    error?: { message?: string; status?: string; code?: number };
    message?: string;
  };
  const nestedError = record.result?.error ?? record.error;
  const parts = [
    typeof record.status === "number" ? String(record.status) : "",
    nestedError?.status,
    nestedError?.message,
    typeof nestedError?.code === "number" ? String(nestedError.code) : "",
    record.message
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(" / ");
  }

  if (typeof record.body === "string") {
    try {
      const parsed = JSON.parse(record.body) as { error?: { message?: string; status?: string; code?: number } };
      return [parsed.error?.code, parsed.error?.status, parsed.error?.message].filter(Boolean).join(" / ");
    } catch {
      return record.body.slice(0, 240);
    }
  }

  return "";
}

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  if (existing) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`${src} を読み込めませんでした`));
    document.head.appendChild(script);
  });
}

function readGoogleDriveEnvSettings(): GoogleDriveSettings {
  return {
    clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
    apiKey: process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? ""
  };
}
