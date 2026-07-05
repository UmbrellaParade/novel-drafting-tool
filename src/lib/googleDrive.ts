import type { ManuscriptProject } from "./types";
import { sanitizeFileName } from "./defaultProject";

declare global {
  interface Window {
    gapi?: GoogleApi;
    google?: GoogleIdentity;
  }
}

const DISCOVERY_DOC = "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest";
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const DRIVE_SETTINGS_STORAGE_KEY = "umbrella-parade:google-drive-settings";

export type GoogleDriveSettings = {
  clientId: string;
  apiKey: string;
};

type TokenResponse = {
  error?: string;
};

type TokenClient = {
  callback: (response: TokenResponse) => void;
  requestAccessToken: (options: { prompt: string }) => void;
};

type GoogleApi = {
  load: (library: string, callback: () => void) => void;
  client: {
    init: (config: { apiKey?: string; discoveryDocs: string[] }) => Promise<void>;
    request: (request: {
      path: string;
      method: "POST" | "PATCH";
      params: { uploadType: "multipart" };
      headers: Record<string, string>;
      body: string;
    }) => Promise<{ result: { id: string } }>;
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
  saveProject: (project: ManuscriptProject) => Promise<{ fileId: string; savedAt: string }>;
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
    saveProject
  };
}

async function initializeGoogleClients(settings: GoogleDriveSettings): Promise<void> {
  const settingsSignature = `${settings.clientId}:${settings.apiKey}`;
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
    tokenClient.callback = (response: { error?: string }) => {
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

async function saveProject(project: ManuscriptProject): Promise<{ fileId: string; savedAt: string }> {
  if (!window.gapi) {
    throw new Error("Google APIを読み込めませんでした。");
  }

  const metadata = {
    name: `${sanitizeFileName(project.title)}.json`,
    mimeType: "application/json"
  };
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

  const existingFileId = project.drive?.fileId;
  const response = await window.gapi.client.request({
    path: existingFileId ? `/upload/drive/v3/files/${existingFileId}` : "/upload/drive/v3/files",
    method: existingFileId ? "PATCH" : "POST",
    params: { uploadType: "multipart" },
    headers: {
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body
  });

  return {
    fileId: response.result.id,
    savedAt: new Date().toISOString()
  };
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
