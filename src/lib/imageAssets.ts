// 画像アセット管理。
// 挿絵画像のバイナリを本文HTMLから分離してIndexedDBに保存し、
// 本文側には data-asset-id と、実行時のみ有効な blob: URL を持たせる。
// 保存時（ブラウザ保存・JSON・Drive）は src を "asset://<id>" に置き換えることで、
// 原稿HTMLの直列化・保存・チェック処理が画像サイズに影響されないようにする。
//
// QRカード内の画像（生成された小さなQRコード）は対象外のまま据え置く。

export const APP_DB_NAME = "umbrella-parade-novel-drafting-tool";
export const APP_DB_VERSION = 2;
export const PROJECT_STORE = "projects";
export const ASSET_STORE = "assets";

const ASSET_URL_PREFIX = "asset://";

type AssetRecord = {
  id: string;
  blob: Blob;
  updatedAt: string;
};

const objectUrlByAssetId = new Map<string, string>();

export function openAppDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(APP_DB_NAME, APP_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        db.createObjectStore(ASSET_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDBを開けませんでした。"));
    request.onblocked = () => reject(new Error("IndexedDBが別のタブで使用中です。"));
  });
}

async function withAssetStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T> | T): Promise<T> {
  const db = await openAppDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(ASSET_STORE, mode);
      const store = transaction.objectStore(ASSET_STORE);
      let result: T;
      Promise.resolve(run(store)).then(
        (value) => {
          result = value;
        },
        (error) => reject(error)
      );
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error("画像アセットの保存に失敗しました。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("画像アセットの保存が中断されました。"));
    });
  } finally {
    db.close();
  }
}

function writeAssetRecord(store: IDBObjectStore, record: AssetRecord): void {
  store.put(record);
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB読み込みに失敗しました。"));
  });
}

function registerObjectUrl(assetId: string, blob: Blob): string {
  const existing = objectUrlByAssetId.get(assetId);
  if (existing) {
    return existing;
  }

  const url = URL.createObjectURL(blob);
  objectUrlByAssetId.set(assetId, url);
  return url;
}

export function resolveAssetUrl(assetId: string): string | null {
  return objectUrlByAssetId.get(assetId) ?? null;
}

export async function internImageBlob(blob: Blob, assetId = crypto.randomUUID()): Promise<{ assetId: string; url: string }> {
  await withAssetStore("readwrite", (store) => {
    writeAssetRecord(store, { id: assetId, blob, updatedAt: new Date().toISOString() });
  });
  return { assetId, url: registerObjectUrl(assetId, blob) };
}

export async function internImageDataUrl(dataUrl: string, assetId?: string): Promise<{ assetId: string; url: string }> {
  const blob = await (await fetch(dataUrl)).blob();
  return internImageBlob(blob, assetId);
}

async function loadAssetBlobs(assetIds: string[]): Promise<Map<string, Blob>> {
  const missing = assetIds.filter((id) => !objectUrlByAssetId.has(id));
  const blobs = new Map<string, Blob>();
  if (missing.length === 0) {
    return blobs;
  }

  await withAssetStore("readonly", async (store) => {
    await Promise.all(
      missing.map(async (id) => {
        const record = (await requestAsPromise(store.get(id))) as AssetRecord | undefined;
        if (record?.blob) {
          blobs.set(id, record.blob);
        }
      })
    );
  });
  return blobs;
}

function isManagedManuscriptImage(image: HTMLImageElement): boolean {
  // QRカードの画像は小さな生成物なので分離管理の対象外
  return !image.closest("figure[data-type='qr-card']") && !image.classList.contains("qr-card-image");
}

function parseHtmlTemplate(html: string): HTMLTemplateElement {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template;
}

export function collectReferencedAssetIds(htmlList: string[]): Set<string> {
  const ids = new Set<string>();
  for (const html of htmlList) {
    if (!html.includes("data-asset-id")) {
      continue;
    }
    const template = parseHtmlTemplate(html);
    template.content.querySelectorAll<HTMLImageElement>("img[data-asset-id]").forEach((image) => {
      const id = image.getAttribute("data-asset-id");
      if (id) {
        ids.add(id);
      }
    });
  }
  return ids;
}

// 保存用HTML: blob: URL を安定した asset:// 参照に置き換える。
export function toPersistedImageHtml(html: string): string {
  if (!html.includes("data-asset-id")) {
    return html;
  }

  const template = parseHtmlTemplate(html);
  let changed = false;
  template.content.querySelectorAll<HTMLImageElement>("img[data-asset-id]").forEach((image) => {
    const assetId = image.getAttribute("data-asset-id");
    if (!assetId || !isManagedManuscriptImage(image)) {
      return;
    }

    const src = image.getAttribute("src") ?? "";
    if (src.startsWith("blob:") || src.startsWith("data:")) {
      image.setAttribute("src", `${ASSET_URL_PREFIX}${assetId}`);
      changed = true;
    }
  });
  return changed ? template.innerHTML : html;
}

// 実行時HTML: asset:// 参照を blob: URL に戻す。
// 旧形式（data: URI 直埋め込み）の画像は、このタイミングでアセットに移行する。
export async function toRuntimeImageHtml(html: string): Promise<{ html: string; migrated: boolean }> {
  if (!html.includes("<img")) {
    return { html, migrated: false };
  }

  const template = parseHtmlTemplate(html);
  const images = Array.from(template.content.querySelectorAll<HTMLImageElement>("img")).filter(isManagedManuscriptImage);
  if (images.length === 0) {
    return { html, migrated: false };
  }

  const neededIds = images
    .map((image) => image.getAttribute("data-asset-id"))
    .filter((id): id is string => Boolean(id));
  const loadedBlobs = await loadAssetBlobs(neededIds);
  loadedBlobs.forEach((blob, id) => registerObjectUrl(id, blob));

  let changed = false;
  let migrated = false;
  for (const image of images) {
    const src = image.getAttribute("src") ?? "";
    const assetId = image.getAttribute("data-asset-id");

    if (assetId) {
      const url = resolveAssetUrl(assetId);
      if (url && src !== url) {
        image.setAttribute("src", url);
        changed = true;
      }
      continue;
    }

    if (src.startsWith("data:")) {
      // 旧形式からの移行: data URI をアセット化して参照に置き換える
      const { assetId: newId, url } = await internImageDataUrl(src);
      image.setAttribute("data-asset-id", newId);
      image.setAttribute("src", url);
      changed = true;
      migrated = true;
    }
  }

  return { html: changed ? template.innerHTML : html, migrated };
}

// JSON書き出し用: 参照されているアセットを data URI 化して同梱する。
export async function exportAssetsAsDataUrls(assetIds: Set<string>): Promise<Record<string, string>> {
  const ids = Array.from(assetIds);
  if (ids.length === 0) {
    return {};
  }

  const result: Record<string, string> = {};
  const records = new Map<string, Blob>();
  await withAssetStore("readonly", async (store) => {
    await Promise.all(
      ids.map(async (id) => {
        const record = (await requestAsPromise(store.get(id))) as AssetRecord | undefined;
        if (record?.blob) {
          records.set(id, record.blob);
        }
      })
    );
  });

  for (const [id, blob] of records) {
    result[id] = await blobToDataUrl(blob);
  }
  return result;
}

// JSON読み込み用: 同梱アセットを（同じIDで）取り込む。
export async function importAssetsFromDataUrls(assets: Record<string, string> | undefined): Promise<void> {
  if (!assets) {
    return;
  }

  for (const [assetId, dataUrl] of Object.entries(assets)) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      continue;
    }
    await internImageDataUrl(dataUrl, assetId);
  }
}

// 参照されなくなったアセットを削除する（起動時の読み込み後に呼ぶ）。
export async function purgeUnreferencedAssets(referencedIds: Set<string>): Promise<void> {
  await withAssetStore("readwrite", async (store) => {
    const keys = (await requestAsPromise(store.getAllKeys())) as string[];
    for (const key of keys) {
      if (!referencedIds.has(key)) {
        store.delete(key);
      }
    }
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}
