import type { ManuscriptProject } from "./types";
import { normalizeProject, sanitizeFileName } from "./defaultProject";

const STORAGE_KEY = "umbrella-parade:novel-drafting-tool:project";

export function saveProjectToBrowser(project: ManuscriptProject): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
}

export function loadProjectFromBrowser(): ManuscriptProject | null {
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
  anchor.click();
  URL.revokeObjectURL(url);
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
