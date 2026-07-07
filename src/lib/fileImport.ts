// Word(.docx)・テキスト(.txt)ファイルを本文HTMLへ変換する。
// WordやGoogleドキュメントからの乗り換え・併用を想定し、
// 「開く」からそのまま原稿として読み込めるようにする。

import { toRuntimeImageHtml } from "./imageAssets";

export type ImportedManuscript = {
  title: string;
  contentHtml: string;
};

export function fileBaseName(fileName: string): string {
  const withoutPath = fileName.split(/[\\/]/).pop() ?? fileName;
  const dotIndex = withoutPath.lastIndexOf(".");
  return (dotIndex > 0 ? withoutPath.slice(0, dotIndex) : withoutPath).trim() || "無題の原稿";
}

// Word文書をHTMLへ変換する。見出し・段落・太字などの構造は保持され、
// 埋め込み画像はdata URIとして取り出された後、アセットストアへ分離される。
export async function importDocxAsHtml(file: File): Promise<ImportedManuscript> {
  const mammoth = await import("mammoth");
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });
  const rawHtml = (result.value ?? "").trim();
  if (!rawHtml) {
    throw new Error("Wordファイルから本文を取り出せませんでした。");
  }

  // 画像バイナリは本文に残さずアセットへ移す
  const { html } = await toRuntimeImageHtml(rawHtml);
  return { title: fileBaseName(file.name), contentHtml: html };
}

// テキストファイルを段落HTMLへ変換する。
// 日本語の.txtはShift_JISのことも多いため、UTF-8で読めない場合は自動判別する。
export async function importTextAsHtml(file: File): Promise<ImportedManuscript> {
  const buffer = await file.arrayBuffer();
  const text = decodeJapaneseText(buffer);
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : "<p></p>"));

  const contentHtml = paragraphs.join("").trim();
  if (!contentHtml) {
    throw new Error("テキストファイルが空です。");
  }

  return { title: fileBaseName(file.name), contentHtml };
}

function decodeJapaneseText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("shift-jis").decode(buffer);
    } catch {
      return new TextDecoder("utf-8").decode(buffer);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
