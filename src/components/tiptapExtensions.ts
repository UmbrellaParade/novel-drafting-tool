import { Extension, Mark, mergeAttributes, Node } from "@tiptap/core";
import type { DOMOutputSpec, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

function readFontSize(element: HTMLElement): string | null {
  return element.style.fontSize || element.getAttribute("data-font-size") || null;
}

function manuscriptColumnCount(value: unknown): 2 | 3 {
  return Number(value) === 3 ? 3 : 2;
}

function manuscriptColumnGapMm(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(12, parsed)) : 4;
}

function readLineHeight(element: HTMLElement): string | null {
  return element.style.lineHeight || element.getAttribute("data-line-height") || null;
}

function fontSizeAttributes(fontSize: string | null | undefined): Record<string, string> {
  if (!fontSize) {
    return {};
  }

  return {
    "data-font-size": fontSize,
    style: `font-size: ${fontSize}`
  };
}

function lineHeightAttributes(lineHeight: string | number | null | undefined, locked: unknown): Record<string, string> {
  if (!lineHeight) {
    return {};
  }

  return {
    "data-line-height": String(lineHeight),
    ...(locked ? { "data-line-height-locked": "true" } : {}),
    style: `line-height: ${lineHeight}`
  };
}

function positiveRoundedDimension(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function qrCardSizeAttributes(width: unknown, height: unknown): Record<string, string> {
  const roundedWidth = positiveRoundedDimension(width);
  const roundedHeight = positiveRoundedDimension(height);
  const attributes: Record<string, string> = {};
  const styles: string[] = [];

  if (roundedWidth) {
    attributes["data-width"] = String(roundedWidth);
    styles.push(`--qr-card-width: ${roundedWidth}px`, `width: ${roundedWidth}px`);
  }

  if (roundedHeight) {
    attributes["data-height"] = String(roundedHeight);
    styles.push(`--qr-card-height: ${roundedHeight}px`, `height: ${roundedHeight}px`);
  }

  if (styles.length > 0) {
    attributes.style = styles.join("; ");
  }

  return attributes;
}

function positiveRoundedFontSize(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Number(parsed.toFixed(1)) : null;
}

function qrCardTextSizeAttributes(
  labelFontSizePt: unknown,
  titleFontSizePt: unknown,
  descriptionFontSizePt: unknown
): Record<string, string> {
  const labelSize = positiveRoundedFontSize(labelFontSizePt);
  const titleSize = positiveRoundedFontSize(titleFontSizePt);
  const descriptionSize = positiveRoundedFontSize(descriptionFontSizePt);
  const attributes: Record<string, string> = {};
  const styles: string[] = [];

  if (labelSize) {
    attributes["data-label-font-size-pt"] = String(labelSize);
    styles.push(`--qr-label-font-size: ${labelSize}pt`);
  }

  if (titleSize) {
    attributes["data-title-font-size-pt"] = String(titleSize);
    styles.push(`--qr-title-font-size: ${titleSize}pt`);
  }

  if (descriptionSize) {
    attributes["data-description-font-size-pt"] = String(descriptionSize);
    styles.push(`--qr-description-font-size: ${descriptionSize}pt`);
  }

  if (styles.length > 0) {
    attributes.style = styles.join("; ");
  }

  return attributes;
}

type TocNodeItem = {
  title: string;
  page: number | null;
};

function readTocItems(value: unknown): TocNodeItem[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => ({
        title: typeof item?.title === "string" ? item.title : "",
        page: typeof item?.page === "number" && Number.isFinite(item.page) ? item.page : null
      }))
      .filter((item) => item.title);
  }

  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    return readTocItems(JSON.parse(value));
  } catch {
    return [];
  }
}

function tocItemsFromElement(element: HTMLElement): TocNodeItem[] {
  const savedItems = element.dataset.items;
  if (savedItems) {
    return readTocItems(savedItems);
  }

  return [...element.querySelectorAll<HTMLElement>(".toc-entry")].map((entry) => {
    const pageText = entry.querySelector(".toc-entry-page")?.textContent?.trim() ?? "";
    const page = Number.parseInt(pageText, 10);
    return {
      title: entry.querySelector(".toc-entry-title")?.textContent?.trim() ?? "",
      page: Number.isFinite(page) ? page : null
    };
  }).filter((item) => item.title);
}

function tocStyle(value: unknown): string {
  return value === "plain" || value === "rain" || value === "antique" || value === "midnight" || value === "ornate" || value === "classic" ? value : "classic";
}

function tocTitlePosition(value: unknown): "start" | "center" {
  return value === "start" ? "start" : "center";
}

function tocItemsAttribute(items: unknown): string {
  return JSON.stringify(readTocItems(items));
}

function verticalTextOutput(value: string): DOMOutputSpec {
  const matches = [
    ...Array.from(value.matchAll(/…+|[.．]{3,}|[―—─]+/g)).map((match) => ({
      index: match.index ?? 0,
      text: match[0],
      className: /[―—─]/.test(match[0]) ? "vertical-dash" : "vertical-ellipsis"
    })),
    ...Array.from(value.matchAll(/\d+/g))
      .filter((match) => match[0].length <= 2)
      .map((match) => ({ index: match.index ?? 0, text: match[0], className: "vertical-tate-chu-yoko" })),
    ...Array.from(value.matchAll(/[!?！？]{2}/g)).map((match) => ({
      index: match.index ?? 0,
      text: match[0],
      className: "vertical-tate-chu-yoko"
    }))
  ].sort((left, right) => left.index - right.index);
  if (matches.length === 0) {
    return ["span", { class: "vertical-text-content" }, value];
  }

  const output: Array<string | DOMOutputSpec> = [];
  let offset = 0;
  matches.forEach((match) => {
    if (match.index < offset) {
      return;
    }
    if (match.index > offset) {
      output.push(value.slice(offset, match.index));
    }
    output.push(["span", { class: match.className }, match.text]);
    offset = match.index + match.text.length;
  });
  if (offset < value.length) {
    output.push(value.slice(offset));
  }

  return ["span", { class: "vertical-text-content" }, ...output] as DOMOutputSpec;
}

type ImageDimensionEntry = {
  position: number;
  width: number | null;
  height: number | null;
  pageBreakBefore: boolean;
};

function imageDimensionEntries(doc: ProseMirrorNode): ImageDimensionEntry[] {
  const entries: ImageDimensionEntry[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === "image") {
      entries.push({
        position,
        width: positiveRoundedDimension(node.attrs.width),
        height: positiveRoundedDimension(node.attrs.height),
        pageBreakBefore: Boolean(node.attrs.pageBreakBefore)
      });
    }
  });
  return entries;
}

function sameImageDimensions(left: ImageDimensionEntry[], right: ImageDimensionEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => (
    entry.width === right[index].width &&
    entry.height === right[index].height &&
    entry.pageBreakBefore === right[index].pageBreakBefore
  ));
}

function rangeContainsImage(doc: ProseMirrorNode, from: number, to: number): boolean {
  const start = Math.max(0, Math.min(doc.content.size, from));
  const end = Math.max(start, Math.min(doc.content.size, to));
  let containsImage = doc.nodeAt(start)?.type.name === "image";
  doc.nodesBetween(Math.max(0, start - 1), Math.min(doc.content.size, Math.max(end, start + 1)), (node) => {
    if (node.type.name === "image") {
      containsImage = true;
      return false;
    }
    return !containsImage;
  });
  return containsImage;
}

function imageMayHaveChanged(previousDoc: ProseMirrorNode, nextDoc: ProseMirrorNode): boolean {
  const start = previousDoc.content.findDiffStart(nextDoc.content);
  if (start === null) {
    return false;
  }

  const end = previousDoc.content.findDiffEnd(nextDoc.content) ?? { a: start, b: start };
  return rangeContainsImage(previousDoc, start, end.a) || rangeContainsImage(nextDoc, start, end.b);
}

function syncRenderedImageDimensions(view: EditorView, entry: ImageDimensionEntry): void {
  const nodeDom = view.nodeDOM(entry.position);
  const image = nodeDom instanceof HTMLImageElement
    ? nodeDom
    : nodeDom instanceof HTMLElement
      ? nodeDom.querySelector<HTMLImageElement>("img:not(.qr-card-image)")
      : null;
  if (!image) {
    return;
  }

  if (entry.width) {
    image.style.width = `${entry.width}px`;
    image.setAttribute("width", String(entry.width));
  } else {
    image.style.removeProperty("width");
    image.removeAttribute("width");
  }

  if (entry.height) {
    image.style.height = `${entry.height}px`;
    image.setAttribute("height", String(entry.height));
  } else {
    image.style.height = "auto";
    image.removeAttribute("height");
  }

  const wrapper = image.closest<HTMLElement>("[data-resize-wrapper]");
  wrapper?.style.removeProperty("width");
  wrapper?.style.removeProperty("max-width");

  const layoutTarget = image.closest<HTMLElement>("[data-resize-container]") ?? image;
  if (entry.pageBreakBefore) {
    layoutTarget.setAttribute("data-page-break-before", "true");
  } else {
    layoutTarget.removeAttribute("data-page-break-before");
  }
}

function tocBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

export const FontSizeMark = Mark.create({
  name: "fontSize",

  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: (element) => readFontSize(element as HTMLElement),
        renderHTML: (attributes) => fontSizeAttributes(attributes.size)
      }
    };
  },

  parseHTML() {
    return [{ tag: "span[style*=font-size]" }, { tag: "span[data-font-size]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  }
});

export const BlockFontSizeExtension = Extension.create({
  name: "blockFontSize",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "blockquote", "listItem"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => readFontSize(element as HTMLElement),
            renderHTML: (attributes) => fontSizeAttributes(attributes.fontSize)
          }
        }
      }
    ];
  }
});

export const BlockLineHeightExtension = Extension.create({
  name: "blockLineHeight",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "blockquote", "listItem"],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (element) => readLineHeight(element as HTMLElement),
            renderHTML: (attributes) => lineHeightAttributes(attributes.lineHeight, attributes.lineHeightLocked)
          },
          lineHeightLocked: {
            default: false,
            parseHTML: (element) => (element as HTMLElement).getAttribute("data-line-height-locked") === "true",
            renderHTML: () => ({})
          }
        }
      }
    ];
  }
});

export const VerticalPunctuationExtension = Extension.create({
  name: "verticalPunctuation",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const decorations: Decoration[] = [];

            state.doc.descendants((node, position) => {
              if (!node.isText || !node.text) {
                return;
              }

              for (const match of node.text.matchAll(/…+|[.．]{3,}|[―—─]+/g)) {
                const start = position + (match.index ?? 0);
                const className = /[―—─]/.test(match[0]) ? "vertical-dash" : "vertical-ellipsis";
                decorations.push(Decoration.inline(start, start + match[0].length, { class: className }));
              }

              for (const match of node.text.matchAll(/\d+/g)) {
                if (match[0].length > 2) {
                  continue;
                }
                const start = position + (match.index ?? 0);
                decorations.push(Decoration.inline(start, start + match[0].length, { class: "vertical-tate-chu-yoko" }));
              }

              for (const match of node.text.matchAll(/[!?！？]{2}/g)) {
                const start = position + (match.index ?? 0);
                decorations.push(Decoration.inline(start, start + match[0].length, { class: "vertical-tate-chu-yoko" }));
              }
            });

            return DecorationSet.create(state.doc, decorations);
          }
        }
      })
    ];
  }
});

// 画像ノードに data-asset-id を保持させる。
// 画像バイナリはIndexedDB側（imageAssets.ts）にあり、srcは実行時のみ有効なblob: URL。
export const ImageAssetIdExtension = Extension.create({
  name: "imageAssetId",

  addGlobalAttributes() {
    return [
      {
        types: ["image"],
        attributes: {
          assetId: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-asset-id"),
            renderHTML: (attributes) => {
              if (!attributes.assetId) {
                return {};
              }

              return { "data-asset-id": attributes.assetId };
            }
          }
        }
      }
    ];
  }
});

export const ImageDimensionSyncExtension = Extension.create({
  name: "imageDimensionSync",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (initialView) => {
          let dimensions = imageDimensionEntries(initialView.state.doc);
          const initialSyncFrame = window.requestAnimationFrame(() => {
            dimensions.forEach((entry) => syncRenderedImageDimensions(initialView, entry));
            initialView.dom.dispatchEvent(new CustomEvent("manuscript:image-dimensions-synced"));
          });
          return {
            update: (view, previousState) => {
              if (!imageMayHaveChanged(previousState.doc, view.state.doc)) {
                return;
              }

              const nextDimensions = imageDimensionEntries(view.state.doc);
              if (sameImageDimensions(dimensions, nextDimensions)) {
                return;
              }

              dimensions = nextDimensions;
              nextDimensions.forEach((entry) => syncRenderedImageDimensions(view, entry));
              view.dom.dispatchEvent(new CustomEvent("manuscript:image-dimensions-synced"));
            },
            destroy: () => window.cancelAnimationFrame(initialSyncFrame)
          };
        }
      })
    ];
  }
});

export const ColumnBlockNode = Node.create({
  name: "columnBlock",
  group: "block",
  content: "block+",
  defining: true,
  selectable: true,

  addAttributes() {
    return {
      columns: {
        default: 2,
        parseHTML: (element) => manuscriptColumnCount((element as HTMLElement).dataset.columns),
        renderHTML: (attributes) => ({ "data-columns": String(manuscriptColumnCount(attributes.columns)) })
      },
      gapMm: {
        default: 4,
        parseHTML: (element) => manuscriptColumnGapMm((element as HTMLElement).dataset.gapMm),
        renderHTML: (attributes) => ({ "data-gap-mm": String(manuscriptColumnGapMm(attributes.gapMm)) })
      }
    };
  },

  parseHTML() {
    return [{ tag: "section[data-type='column-block']" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const columns = manuscriptColumnCount(node.attrs.columns);
    const gapMm = manuscriptColumnGapMm(node.attrs.gapMm);
    return [
      "section",
      mergeAttributes(HTMLAttributes, {
        "data-type": "column-block",
        "data-columns": String(columns),
        "data-gap-mm": String(gapMm),
        class: `manuscript-column-block manuscript-column-block-${columns}`,
        style: `--manuscript-column-count: ${columns}; --manuscript-column-gap: ${gapMm}mm`
      }),
      0
    ];
  }
});

export const PageBreakBeforeExtension = Extension.create({
  name: "pageBreakBefore",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "image", "qrCard", "tableOfContents", "columnBlock"],
        attributes: {
          pageBreakBefore: {
            default: false,
            parseHTML: (element) => element.getAttribute("data-page-break-before") === "true" || element.classList.contains("page-break-before"),
            renderHTML: (attributes) => {
              if (!attributes.pageBreakBefore) {
                return {};
              }

              return {
                "data-page-break-before": "true",
                class: "page-break-before"
              };
            }
          },
          verticalPageCenter: {
            default: false,
            parseHTML: (element) => element.getAttribute("data-vertical-page-center") === "true" || element.classList.contains("vertical-page-center"),
            renderHTML: (attributes) => {
              if (!attributes.verticalPageCenter) {
                return {};
              }

              return {
                "data-vertical-page-center": "true",
                class: "vertical-page-center"
              };
            }
          }
        }
      }
    ];
  }
});

export const TableOfContentsNode = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      title: { default: "目次" },
      subtitle: { default: "" },
      style: { default: "classic" },
      titlePosition: {
        default: "center",
        parseHTML: (element) => tocTitlePosition((element as HTMLElement).dataset.titlePosition),
        renderHTML: (attributes) => ({ "data-title-position": tocTitlePosition(attributes.titlePosition) })
      },
      showPageNumbers: {
        default: true,
        parseHTML: (element) => tocBoolean((element as HTMLElement).dataset.showPageNumbers, true),
        renderHTML: (attributes) => ({ "data-show-page-numbers": String(tocBoolean(attributes.showPageNumbers, true)) })
      },
      enableLinks: {
        default: false,
        parseHTML: (element) => tocBoolean((element as HTMLElement).dataset.enableLinks, false),
        renderHTML: (attributes) => ({ "data-enable-links": String(tocBoolean(attributes.enableLinks, false)) })
      },
      fontSizePt: {
        default: null,
        parseHTML: (element) => {
          const v = (element as HTMLElement).dataset.fontSizePt;
          return v ? Number.parseFloat(v) : null;
        },
        renderHTML: (attributes) => {
          if (!attributes.fontSizePt) return {};
          return { "data-font-size-pt": String(attributes.fontSizePt) };
        }
      },
      titleGapPt: {
        default: null,
        parseHTML: (element) => {
          const v = (element as HTMLElement).dataset.titleGapPt;
          return v ? Number.parseFloat(v) : null;
        },
        renderHTML: (attributes) => {
          if (!attributes.titleGapPt && attributes.titleGapPt !== 0) return {};
          return { "data-title-gap-pt": String(attributes.titleGapPt) };
        }
      },
      leaderWidthMm: {
        default: null,
        parseHTML: (element) => {
          const v = (element as HTMLElement).dataset.leaderWidthMm;
          return v ? Number.parseFloat(v) : null;
        },
        renderHTML: (attributes) => {
          if (!attributes.leaderWidthMm && attributes.leaderWidthMm !== 0) return {};
          return { "data-leader-width-mm": String(attributes.leaderWidthMm) };
        }
      },
      verticalPageNumberOffsetMm: {
        default: null,
        parseHTML: (element) => {
          const v = (element as HTMLElement).dataset.verticalPageNumberOffsetMm;
          return v ? Number.parseFloat(v) : null;
        },
        renderHTML: (attributes) => {
          if (!attributes.verticalPageNumberOffsetMm && attributes.verticalPageNumberOffsetMm !== 0) return {};
          return { "data-vertical-page-number-offset-mm": String(attributes.verticalPageNumberOffsetMm) };
        }
      },
      items: {
        default: "[]",
        parseHTML: (element) => (element as HTMLElement).dataset.items ?? "[]",
        renderHTML: (attributes) => ({
          "data-items": tocItemsAttribute(attributes.items)
        })
      }
    };
  },

  parseHTML() {
    return [
      {
        tag: "section[data-type='table-of-contents']",
        getAttrs: (node) => {
          const element = node as HTMLElement;
          const fontSizePtRaw = element.dataset.fontSizePt;
          return {
            title: element.dataset.title ?? element.querySelector(".toc-title")?.textContent ?? "目次",
            subtitle: element.dataset.subtitle ?? element.querySelector(".toc-subtitle")?.textContent ?? "",
            style: tocStyle(element.dataset.style),
            titlePosition: tocTitlePosition(element.dataset.titlePosition),
            showPageNumbers: tocBoolean(element.dataset.showPageNumbers, true),
            enableLinks: tocBoolean(element.dataset.enableLinks, false),
            fontSizePt: fontSizePtRaw ? Number.parseFloat(fontSizePtRaw) : null,
            titleGapPt: element.dataset.titleGapPt ? Number.parseFloat(element.dataset.titleGapPt) : null,
            leaderWidthMm: element.dataset.leaderWidthMm ? Number.parseFloat(element.dataset.leaderWidthMm) : null,
            verticalPageNumberOffsetMm: element.dataset.verticalPageNumberOffsetMm ? Number.parseFloat(element.dataset.verticalPageNumberOffsetMm) : null,
            items: JSON.stringify(tocItemsFromElement(element))
          };
        }
      }
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const style = tocStyle(node.attrs.style);
    const titlePosition = tocTitlePosition(node.attrs.titlePosition);
    const items = readTocItems(node.attrs.items);
    const showPageNumbers = tocBoolean(node.attrs.showPageNumbers, true);
    const enableLinks = tocBoolean(node.attrs.enableLinks, false);
    const fontSizePt = typeof node.attrs.fontSizePt === "number" && node.attrs.fontSizePt > 0
      ? node.attrs.fontSizePt
      : null;
    const titleGapPt = typeof node.attrs.titleGapPt === "number" && node.attrs.titleGapPt >= 0
      ? node.attrs.titleGapPt
      : null;
    const leaderWidthMm = typeof node.attrs.leaderWidthMm === "number" && node.attrs.leaderWidthMm >= 0
      ? node.attrs.leaderWidthMm
      : null;
    const verticalPageNumberOffsetMm = typeof node.attrs.verticalPageNumberOffsetMm === "number" && node.attrs.verticalPageNumberOffsetMm >= 0
      ? node.attrs.verticalPageNumberOffsetMm
      : null;
    const styleRules = [
      fontSizePt ? `font-size: ${fontSizePt}pt` : "",
      titleGapPt !== null ? `--toc-title-gap: ${titleGapPt}pt` : "",
      leaderWidthMm !== null ? `--toc-leader-width: ${leaderWidthMm}mm` : "",
      verticalPageNumberOffsetMm !== null ? `--toc-page-number-offset: ${verticalPageNumberOffsetMm}mm` : ""
    ].filter(Boolean);
    const blockStyle = styleRules.length ? styleRules.join("; ") : undefined;

    return [
      "section",
      mergeAttributes(HTMLAttributes, {
        "data-type": "table-of-contents",
        "data-title": node.attrs.title,
        "data-subtitle": "",
        "data-style": style,
        "data-title-position": titlePosition,
        "data-show-page-numbers": String(showPageNumbers),
        "data-enable-links": String(enableLinks),
        ...(fontSizePt ? { "data-font-size-pt": String(fontSizePt) } : {}),
        ...(titleGapPt !== null ? { "data-title-gap-pt": String(titleGapPt) } : {}),
        ...(leaderWidthMm !== null ? { "data-leader-width-mm": String(leaderWidthMm) } : {}),
        ...(verticalPageNumberOffsetMm !== null ? { "data-vertical-page-number-offset-mm": String(verticalPageNumberOffsetMm) } : {}),
        ...(blockStyle ? { style: blockStyle } : {}),
        class: `manuscript-toc manuscript-toc-${style}${showPageNumbers ? "" : " manuscript-toc-without-pages"}${enableLinks ? " manuscript-toc-with-links" : ""}`
      }),
      ["div", { class: "toc-title" }, verticalTextOutput(node.attrs.title || "目次")],
      [
        "ol",
        { class: "toc-list" },
        ...items.map((item, index) => {
          const title = enableLinks
            ? ["a", { class: "toc-entry-title toc-entry-link", role: "link", tabindex: "0", "data-toc-target-index": String(index) }, verticalTextOutput(item.title)]
            : ["span", { class: "toc-entry-title" }, verticalTextOutput(item.title)];
          return [
            "li",
            { class: "toc-entry" },
            title,
            ...(showPageNumbers
              ? [
                  ["span", { class: "toc-entry-leader" }, ""],
                  ["span", { class: "toc-entry-page" }, verticalTextOutput(item.page === null ? "…" : String(item.page))]
                ]
              : [])
          ];
        })
      ]
    ];
  },

  renderText({ node }) {
    const items = readTocItems(node.attrs.items);
    const showPageNumbers = tocBoolean(node.attrs.showPageNumbers, true);
    return [node.attrs.title || "目次", ...items.map((item) => showPageNumbers ? `${item.title} ${item.page ?? ""}`.trim() : item.title)].join("\n");
  }
});

export const PageBreakNode = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: "div[data-type='page-break']" }, { tag: "hr[data-type='page-break']" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "page-break", class: "page-break" })];
  }
});

export const RubyTextNode = Node.create({
  name: "rubyText",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      base: {
        default: ""
      },
      rt: {
        default: ""
      }
    };
  },

  parseHTML() {
    return [
      {
        tag: "ruby",
        getAttrs: (node) => {
          const element = node as HTMLElement;
          const rt = element.querySelector("rt")?.textContent ?? "";
          const clone = element.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("rt").forEach((rtElement) => rtElement.remove());
          return {
            base: clone.textContent ?? "",
            rt
          };
        }
      }
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "ruby",
      mergeAttributes(HTMLAttributes, { class: "ruby-text" }),
      node.attrs.base,
      ["rt", {}, node.attrs.rt]
    ];
  },

  renderText({ node }) {
    return `${node.attrs.base}(${node.attrs.rt})`;
  }
});

export const QrCardNode = Node.create({
  name: "qrCard",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      instanceId: { default: "" },
      url: { default: "" },
      title: { default: "QRリンク" },
      description: { default: "" },
      src: { default: "" },
      template: { default: "umbrella" },
      label: { default: "記録室リンク" },
      labelFontSizePt: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).dataset.labelFontSizePt ?? null,
        renderHTML: () => ({})
      },
      titleFontSizePt: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).dataset.titleFontSizePt ?? null,
        renderHTML: () => ({})
      },
      descriptionFontSizePt: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).dataset.descriptionFontSizePt ?? null,
        renderHTML: () => ({})
      },
      width: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).dataset.width ?? (element as HTMLElement).style.width ?? null,
        renderHTML: (attributes) => qrCardSizeAttributes(attributes.width, attributes.height)
      },
      height: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).dataset.height ?? (element as HTMLElement).style.height ?? null,
        renderHTML: () => ({})
      }
    };
  },

  parseHTML() {
    return [
      {
        tag: "figure[data-type='qr-card']",
        getAttrs: (node) => {
          const element = node as HTMLElement;
          return {
            instanceId: element.dataset.instanceId ?? "",
            url: element.dataset.url ?? "",
            title: element.dataset.title ?? element.querySelector(".qr-card-title")?.textContent ?? "QRリンク",
            description: element.dataset.description ?? element.querySelector(".qr-card-description")?.textContent ?? "",
            src: element.dataset.src ?? element.querySelector("img")?.getAttribute("src") ?? "",
            template: element.dataset.template ?? "umbrella",
            label: element.dataset.label ?? "記録室リンク",
            labelFontSizePt: element.dataset.labelFontSizePt ?? null,
            titleFontSizePt: element.dataset.titleFontSizePt ?? null,
            descriptionFontSizePt: element.dataset.descriptionFontSizePt ?? null,
            width: element.dataset.width ?? element.style.width ?? null,
            height: element.dataset.height ?? element.style.height ?? null
          };
        }
      }
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "figure",
      mergeAttributes(HTMLAttributes, {
        "data-type": "qr-card",
        "data-instance-id": node.attrs.instanceId,
        "data-url": node.attrs.url,
        "data-title": node.attrs.title,
        "data-description": node.attrs.description,
        "data-src": node.attrs.src,
        "data-template": node.attrs.template,
        "data-label": node.attrs.label,
        ...qrCardTextSizeAttributes(node.attrs.labelFontSizePt, node.attrs.titleFontSizePt, node.attrs.descriptionFontSizePt),
        class: `qr-card qr-card-${node.attrs.template}`
      }),
      ["div", { class: "qr-card-label" }, node.attrs.label],
      [
        "div",
        { class: "qr-card-body" },
        ["img", { src: node.attrs.src, alt: node.attrs.title, class: "qr-card-image" }],
        [
          "figcaption",
          { class: "qr-card-caption" },
          ["strong", { class: "qr-card-title" }, node.attrs.title],
          ["span", { class: "qr-card-description" }, node.attrs.description]
        ]
      ]
    ];
  },

  renderText({ node }) {
    return `${node.attrs.title} ${node.attrs.url}`;
  }
});
