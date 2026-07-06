// PDF書き出し用のフォント埋め込みCSSを作る。
//
// html-to-image標準のフォント埋め込み（getFontEmbedCSS）は、読み込まれている
// 全ウェイト・全unicode-rangeサブセットをdata URI化するため数十MBに膨らみ、
// SVG画像内でフォントが適用されず折り返し位置が編集画面とズレる。
// ここでは原稿に実際に含まれる文字と交差するサブセットだけを埋め込む。

import { blobToDataUrl } from "./imageAssets";

const GOOGLE_FONTS_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Noto+Serif+JP:wght@400;500;700&display=swap";

// 見出し・ページ番号などで必ず使う文字は常に含める
const ALWAYS_INCLUDED_TEXT = "0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz。、・…「」『』（）：；！？ー―";

export async function buildManuscriptFontEmbedCss(manuscriptText: string): Promise<string> {
  const codepoints = new Set<number>();
  for (const ch of manuscriptText + ALWAYS_INCLUDED_TEXT) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      codepoints.add(cp);
    }
  }

  const response = await fetch(GOOGLE_FONTS_CSS_URL);
  if (!response.ok) {
    throw new Error("フォントCSSを取得できませんでした。");
  }

  const cssText = await response.text();
  const faces = cssText.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  const neededFaces = faces.filter((face) => {
    const rangeMatch = face.match(/unicode-range:\s*([^;}]+)[;}]/);
    if (!rangeMatch) {
      return true;
    }
    return unicodeRangeIntersects(rangeMatch[1], codepoints);
  });

  const inlinedFaces = await Promise.all(
    neededFaces.map(async (face) => {
      const urlMatch = face.match(/url\((https:[^)]+)\)/);
      if (!urlMatch) {
        return face;
      }

      try {
        const fontResponse = await fetch(urlMatch[1]);
        if (!fontResponse.ok) {
          return face;
        }
        const blob = await fontResponse.blob();
        const dataUrl = await blobToDataUrl(new Blob([blob], { type: "font/woff2" }));
        return face.replace(urlMatch[1], dataUrl);
      } catch {
        return face;
      }
    })
  );

  return inlinedFaces.join("\n");
}

function unicodeRangeIntersects(rangeText: string, codepoints: Set<number>): boolean {
  const parts = rangeText.split(",");
  for (const part of parts) {
    const match = part.trim().match(/U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?/i);
    if (!match) {
      continue;
    }

    let start: number;
    let end: number;
    if (match[1].includes("?")) {
      start = Number.parseInt(match[1].replace(/\?/g, "0"), 16);
      end = Number.parseInt(match[1].replace(/\?/g, "F"), 16);
    } else {
      start = Number.parseInt(match[1], 16);
      end = match[2] ? Number.parseInt(match[2], 16) : start;
    }

    for (const cp of codepoints) {
      if (cp >= start && cp <= end) {
        return true;
      }
    }
  }
  return false;
}
