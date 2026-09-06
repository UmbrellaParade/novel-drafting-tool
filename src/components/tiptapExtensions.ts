import { Extension, getRenderedAttributes, isNodeEmpty, Mark, mergeAttributes, Node } from "@tiptap/core";
import { DOMSerializer, type DOMOutputSpec, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

// Only the selected block needs a placeholder; no viewport probing is necessary.
export const ManuscriptPlaceholder = Extension.create({
  name: "manuscriptPlaceholder",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      props: {
        decorations({ doc, selection }) {
          if (!editor.isEditable) return null;
          const resolved = selection.$anchor;
          const node = resolved.depth > 0 ? resolved.node(1) : resolved.nodeAfter;
          if (!node?.isTextblock || !isNodeEmpty(node)) return null;
          const position = resolved.depth > 0 ? resolved.before(1) : resolved.pos;
          return DecorationSet.create(doc, [Decoration.node(position, position + node.nodeSize, {
            class: isNodeEmpty(doc) ? "is-empty is-editor-empty" : "is-empty",
            "data-placeholder": "本文を書きはじめる"
          })]);
        }
      }
    })];
  }
});

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
    ...Array.from(value.matchAll(/…+|[.．]{3,}|[―—─]/g)).map((match) => ({
      index: match.index ?? 0,
      text: match[0],
      className: /[―—─]/.test(match[0]) ? "vertical-dash" : "vertical-ellipsis"
    })),
    ...Array.from(value.matchAll(/\d+/g))
      .filter((match) => match[0].length <= 2)
      .map((match) => ({
        index: match.index ?? 0,
        text: match[0],
        className: "vertical-tate-chu-yoko vertical-tate-chu-yoko-number"
      })),
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

function imageDimensionEntries(doc: ProseMirrorNode, from = 0, to = doc.content.size): ImageDimensionEntry[] {
  const entries: ImageDimensionEntry[] = [];
  doc.nodesBetween(from, to, (node, position) => {
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
      new Plugin<DecorationSet>({
        state: {
          init: (_config, state) => DecorationSet.create(state.doc, punctuationDecorations(state.doc)),
          apply: (transaction, previous, oldState, newState) => {
            if (!transaction.docChanged) {
              return previous;
            }

            const mapped = previous.map(transaction.mapping, newState.doc);
            const start = oldState.doc.content.findDiffStart(newState.doc.content);
            if (start === null) {
              return mapped;
            }
            const end = oldState.doc.content.findDiffEnd(newState.doc.content)?.b ?? start;
            const $from = newState.doc.resolve(Math.min(start, end));
            const $to = newState.doc.resolve(Math.max(start, end));
            // Rebuild whole changed blocks so split/join and digit-run boundaries stay correct.
            const from = $from.depth > 0 ? $from.before(1) : $from.pos;
            const to = $to.depth > 0 ? $to.after(1) : $to.pos;
            const outdated = mapped.find(from, to).filter((decoration) => decoration.from < to && decoration.to > from);
            return mapped.remove(outdated).add(newState.doc, punctuationDecorations(newState.doc, from, to));
          }
        },
        props: {
          decorations(state) {
            return this.getState(state);
          }
        }
      })
    ];
  }
});

function punctuationDecorations(doc: ProseMirrorNode, from = 0, to = doc.content.size): Decoration[] {
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name === "horizontalWritingBlock") {
      return false;
    }
    if (!node.isText || !node.text) {
      return;
    }
    for (const match of node.text.matchAll(/…+|[.．]{3,}|[―—─]/g)) {
      const start = position + (match.index ?? 0);
      decorations.push(Decoration.inline(start, start + match[0].length, {
        class: /[―—─]/.test(match[0]) ? "vertical-dash" : "vertical-ellipsis"
      }));
    }
    for (const match of node.text.matchAll(/\d+/g)) {
      if (match[0].length <= 2) {
        const start = position + (match.index ?? 0);
        decorations.push(Decoration.inline(start, start + match[0].length, {
          class: "vertical-tate-chu-yoko vertical-tate-chu-yoko-number"
        }));
      }
    }
    for (const match of node.text.matchAll(/[!?！？]{2}/g)) {
      const start = position + (match.index ?? 0);
      decorations.push(Decoration.inline(start, start + match[0].length, { class: "vertical-tate-chu-yoko" }));
    }
  });
  return decorations;
}

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
          const initialSyncFrame = window.requestAnimationFrame(() => {
            imageDimensionEntries(initialView.state.doc).forEach((entry) => syncRenderedImageDimensions(initialView, entry));
            initialView.dom.dispatchEvent(new CustomEvent("manuscript:image-dimensions-synced"));
          });
          return {
            update: (view, previousState) => {
              if (previousState.doc === view.state.doc) {
                return;
              }
              const start = previousState.doc.content.findDiffStart(view.state.doc.content);
              if (start === null) {
                return;
              }
              const end = previousState.doc.content.findDiffEnd(view.state.doc.content)?.b ?? start;
              const changedImages = imageDimensionEntries(view.state.doc, Math.min(start, end), Math.max(start, end));
              if (changedImages.length > 0) {
                changedImages.forEach((entry) => syncRenderedImageDimensions(view, entry));
                view.dom.dispatchEvent(new CustomEvent("manuscript:image-dimensions-synced"));
              }
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

export const HorizontalWritingBlockNode = Node.create({
  name: "horizontalWritingBlock",
  group: "block",
  content: "block+",
  defining: true,
  selectable: true,

  parseHTML() {
    return [{ tag: "section[data-type='horizontal-writing-block']" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "section",
      mergeAttributes(HTMLAttributes, {
        "data-type": "horizontal-writing-block",
        class: "horizontal-writing-block"
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
        types: ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "image", "qrCard", "tableOfContents", "columnBlock", "horizontalWritingBlock"],
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

function qrCardAttributes(node: ProseMirrorNode, htmlAttributes: Record<string, unknown>) {
  return mergeAttributes(htmlAttributes, {
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
  });
}

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
      qrCardAttributes(node, HTMLAttributes),
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

  addNodeView() {
    return ({ node, editor }) => {
      const dom = DOMSerializer.fromSchema(editor.schema).serializeNode(node) as HTMLElement;
      const attributesFor = (current: ProseMirrorNode) => qrCardAttributes(current, getRenderedAttributes(current, editor.extensionManager.attributes));
      let attributes = attributesFor(node);
      const label = dom.querySelector<HTMLElement>(".qr-card-label")!;
      const title = dom.querySelector<HTMLElement>(".qr-card-title")!;
      const description = dom.querySelector<HTMLElement>(".qr-card-description")!;
      const image = dom.querySelector<HTMLImageElement>(".qr-card-image")!;
      return {
        dom,
        update(nextNode) {
          if (nextNode.type !== node.type) {
            return false;
          }
          const nextAttributes = attributesFor(nextNode);
          const selected = dom.classList.contains("ProseMirror-selectednode");
          for (const key of Object.keys(attributes)) {
            if (!(key in nextAttributes)) {
              dom.removeAttribute(key);
            }
          }
          for (const [key, value] of Object.entries(nextAttributes)) {
            if (value === null || value === undefined) {
              dom.removeAttribute(key);
              continue;
            }
            const nextValue = key === "class" && selected ? `${value} ProseMirror-selectednode` : String(value);
            if (dom.getAttribute(key) !== nextValue) {
              dom.setAttribute(key, nextValue);
            }
          }
          attributes = nextAttributes;
          for (const [element, value] of [[label, nextNode.attrs.label], [title, nextNode.attrs.title], [description, nextNode.attrs.description]] as const) {
            if (element.textContent !== String(value)) {
              element.textContent = String(value);
            }
          }
          // Keep the decoded QR image and its DOM alive during slider updates.
          if (image.getAttribute("src") !== nextNode.attrs.src) {
            image.setAttribute("src", nextNode.attrs.src);
          }
          if (image.alt !== nextNode.attrs.title) {
            image.alt = nextNode.attrs.title;
          }
          return true;
        },
        ignoreMutation: (mutation) => mutation.type !== "selection"
      };
    };
  },

  renderText({ node }) {
    return `${node.attrs.title} ${node.attrs.url}`;
  }
});
