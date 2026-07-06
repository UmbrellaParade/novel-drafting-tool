import type { ManuscriptProject } from "./types";
import { normalizeProject, sanitizeFileName } from "./defaultProject";

const STORAGE_KEY = "umbrella-parade:novel-drafting-tool:project";
const DB_NAME = "umbrella-parade-novel-drafting-tool";
const DB_VERSION = 1;
const PROJECT_STORE = "projects";
const INDEXED_DB_TIMEOUT_MS = 2500;

type StoredProjectRecord = {
  id: string;
  project: ManuscriptProject;
  updatedAt: string;
};

export async function saveProjectToBrowser(project: ManuscriptProject): Promise<void> {
  try {
    await withTimeout(saveProjectToIndexedDb(project), INDEXED_DB_TIMEOUT_MS);
    localStorage.setItem(`${STORAGE_KEY}:backend`, "indexeddb");
  } catch (error) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    } catch {
      throw new Error(
        error instanceof Error
          ? `ブラウザ保存に失敗しました。画像が大きい場合はJSONで退避してください。(${error.message})`
          : "ブラウザ保存に失敗しました。画像が大きい場合はJSONで退避してください。"
      );
    }
  }
}

export async function loadProjectFromBrowser(): Promise<ManuscriptProject | null> {
  try {
    const indexedProject = await withTimeout(loadProjectFromIndexedDb(), INDEXED_DB_TIMEOUT_MS);
    if (indexedProject) {
      return normalizeProject(indexedProject);
    }
  } catch {
    // Fall back to the legacy localStorage copy below.
  }

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return normalizeProject(JSON.parse(raw) as ManuscriptProject);
  } catch {
    return null;
  }
}

async function saveProjectToIndexedDb(project: ManuscriptProject): Promise<void> {
  const db = await openProjectDb();
  try {
    await writeProjectToIndexedDb(db, project);
  } finally {
    db.close();
  }
}

async function loadProjectFromIndexedDb(): Promise<ManuscriptProject | null> {
  const db = await openProjectDb();
  try {
    return await readProjectFromIndexedDb(db);
  } finally {
    db.close();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = window.setTimeout(() => reject(new Error("IndexedDB操作がタイムアウトしました。")), timeoutMs);
    promise
      .then((value) => resolve(value))
      .catch((error) => reject(error))
      .finally(() => window.clearTimeout(handle));
  });
}

function openProjectDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDBを開けませんでした。"));
    request.onblocked = () => reject(new Error("IndexedDBが別のタブで使用中です。"));
  });
}

function writeProjectToIndexedDb(db: IDBDatabase, project: ManuscriptProject): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PROJECT_STORE, "readwrite");
    const store = transaction.objectStore(PROJECT_STORE);
    const record: StoredProjectRecord = {
      id: STORAGE_KEY,
      project,
      updatedAt: new Date().toISOString()
    };

    store.put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB保存に失敗しました。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB保存が中断されました。"));
  });
}

function readProjectFromIndexedDb(db: IDBDatabase): Promise<ManuscriptProject | null> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PROJECT_STORE, "readonly");
    const store = transaction.objectStore(PROJECT_STORE);
    const request = store.get(STORAGE_KEY);

    request.onsuccess = () => {
      const record = request.result as StoredProjectRecord | undefined;
      resolve(record?.project ?? null);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB読み込みに失敗しました。"));
  });
}

export function exportProjectJson(project: ManuscriptProject): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], {
    type: "application/json;charset=utf-8"
  });
  downloadBlob(blob, `${sanitizeFileName(project.title)}.json`);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 40000);
}

export function readJsonFile(file: File): Promise<ManuscriptProject> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("JSONを読み込めませんでした"));
    reader.onload = () => {
      try {
        resolve(normalizeProject(JSON.parse(String(reader.result)) as ManuscriptProject));
      } catch {
        reject(new Error("JSON形式を確認してください"));
      }
    };
    reader.readAsText(file, "utf-8");
  });
}
