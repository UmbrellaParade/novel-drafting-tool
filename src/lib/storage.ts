import type { ManuscriptProject } from "./types";
import { normalizeProject, sanitizeFileName } from "./defaultProject";
import {
  PROJECT_STORE,
  collectReferencedAssetIds,
  exportAssetsAsDataUrls,
  importAssetsFromDataUrls,
  openAppDb,
  purgeUnreferencedAssets,
  toPersistedImageHtml,
  toRuntimeImageHtml
} from "./imageAssets";

const STORAGE_KEY = "umbrella-parade:novel-drafting-tool:project";
const INDEXED_DB_TIMEOUT_MS = 8000;

type StoredProjectRecord = {
  id: string;
  project: ManuscriptProject;
  updatedAt: string;
};

// JSON書き出し形式: 画像バイナリは assets に data URI で同梱する
export type ExportedProject = ManuscriptProject & {
  assets?: Record<string, string>;
};

// 保存用: 本文中の blob: URL を asset:// 参照に置き換えたプロジェクト
export function toPersistableProject(project: ManuscriptProject): ManuscriptProject {
  return {
    ...project,
    chapters: project.chapters.map((chapter) => ({
      ...chapter,
      content: toPersistedImageHtml(chapter.content)
    }))
  };
}

// 実行時用: asset:// 参照を blob: URL に解決したプロジェクト。
// 旧形式（data URI直埋め込み）はここでアセットに移行される。
export async function toRuntimeProject(project: ManuscriptProject): Promise<{ project: ManuscriptProject; migrated: boolean }> {
  let migrated = false;
  const chapters = [];
  for (const chapter of project.chapters) {
    const result = await toRuntimeImageHtml(chapter.content);
    migrated = migrated || result.migrated;
    chapters.push({ ...chapter, content: result.html });
  }
  return { project: { ...project, chapters }, migrated };
}

export async function saveProjectToBrowser(project: ManuscriptProject): Promise<void> {
  const persistable = toPersistableProject(project);
  try {
    await withTimeout(saveProjectToIndexedDb(persistable), INDEXED_DB_TIMEOUT_MS);
    localStorage.setItem(`${STORAGE_KEY}:backend`, "indexeddb");
  } catch (error) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
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
  const stored = await loadStoredProject();
  if (!stored) {
    return null;
  }

  const { project, migrated } = await toRuntimeProject(normalizeProject(stored));
  if (migrated) {
    // 旧形式からの移行を確定させる（次回以降の再移行と重複アセットを防ぐ）
    try {
      await saveProjectToBrowser(project);
    } catch {
      // 保存に失敗しても編集は続行できる
    }
  }

  try {
    await purgeUnreferencedAssets(collectReferencedAssetIds(project.chapters.map((chapter) => chapter.content)));
  } catch {
    // 掃除の失敗は無視してよい
  }

  return project;
}

async function loadStoredProject(): Promise<ManuscriptProject | null> {
  try {
    const indexedProject = await withTimeout(loadProjectFromIndexedDb(), INDEXED_DB_TIMEOUT_MS);
    if (indexedProject) {
      return indexedProject;
    }
  } catch {
    // Fall back to the legacy localStorage copy below.
  }

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as ManuscriptProject;
  } catch {
    return null;
  }
}

async function saveProjectToIndexedDb(project: ManuscriptProject): Promise<void> {
  const db = await openAppDb();
  try {
    await writeProjectToIndexedDb(db, project);
  } finally {
    db.close();
  }
}

async function loadProjectFromIndexedDb(): Promise<ManuscriptProject | null> {
  const db = await openAppDb();
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

// JSON文字列（画像はdata URIで同梱）を作る。Drive保存とJSON書き出しで共用。
export async function buildExportedProjectJson(project: ManuscriptProject): Promise<string> {
  const persistable = toPersistableProject(project);
  const assetIds = collectReferencedAssetIds(persistable.chapters.map((chapter) => chapter.content));
  const assets = await exportAssetsAsDataUrls(assetIds);
  const exported: ExportedProject = {
    ...persistable,
    ...(Object.keys(assets).length > 0 ? { assets } : {})
  };
  return JSON.stringify(exported, null, 2);
}

export async function exportProjectJson(project: ManuscriptProject): Promise<void> {
  const json = await buildExportedProjectJson(project);
  const blob = new Blob([json], {
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
      void (async () => {
        try {
          const parsed = JSON.parse(String(reader.result)) as ExportedProject;
          const { assets, ...projectData } = parsed;
          await importAssetsFromDataUrls(assets);
          const { project } = await toRuntimeProject(normalizeProject(projectData as ManuscriptProject));
          resolve(project);
        } catch {
          reject(new Error("JSON形式を確認してください"));
        }
      })();
    };
    reader.readAsText(file, "utf-8");
  });
}
