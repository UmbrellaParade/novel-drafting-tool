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

export function isDriveConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID && process.env.NEXT_PUBLIC_GOOGLE_API_KEY);
}

export async function connectGoogleDrive(): Promise<DriveClient> {
  if (!isDriveConfigured()) {
    throw new Error("Google Drive連携には NEXT_PUBLIC_GOOGLE_CLIENT_ID と NEXT_PUBLIC_GOOGLE_API_KEY が必要です。");
  }

  await loadScript("https://apis.google.com/js/api.js");
  await loadScript("https://accounts.google.com/gsi/client");
  await initializeGoogleClients();
  await requestAccessToken();

  return {
    saveProject
  };
}

async function initializeGoogleClients(): Promise<void> {
  if (initialized) {
    return;
  }

  if (!window.gapi || !window.google) {
    throw new Error("Google APIを読み込めませんでした。");
  }

  await new Promise<void>((resolve) => window.gapi?.load("client", resolve));
  await window.gapi.client.init({
    apiKey: process.env.NEXT_PUBLIC_GOOGLE_API_KEY,
    discoveryDocs: [DISCOVERY_DOC]
  });

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    scope: SCOPES,
    callback: () => undefined
  });

  initialized = true;
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
