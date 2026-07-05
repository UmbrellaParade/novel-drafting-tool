import { Extension, Mark, mergeAttributes, Node } from "@tiptap/core";

function readFontSize(element: HTMLElement): string | null {
  return element.style.fontSize || element.getAttribute("data-font-size") || null;
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

function qrCardWidthAttributes(width: unknown): Record<string, string> {
  const parsed = typeof width === "number" ? width : typeof width === "string" ? Number.parseFloat(width) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {};
  }

  const rounded = Math.round(parsed);
  return {
    "data-width": String(rounded),
    style: `--qr-card-width: ${rounded}px; width: ${rounded}px`
  };
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
  return value === "rain" || value === "antique" || value === "midnight" || value === "classic" ? value : "classic";
}

function tocItemsAttribute(items: unknown): string {
  return JSON.stringify(readTocItems(items));
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

export const PageBreakBeforeExtension = Extension.create({
  name: "pageBreakBefore",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "image", "qrCard", "tableOfContents"],
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
          return {
            title: element.dataset.title ?? element.querySelector(".toc-title")?.textContent ?? "目次",
            subtitle: element.dataset.subtitle ?? element.querySelector(".toc-subtitle")?.textContent ?? "",
            style: tocStyle(element.dataset.style),
            items: JSON.stringify(tocItemsFromElement(element))
          };
        }
      }
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const style = tocStyle(node.attrs.style);
    const items = readTocItems(node.attrs.items);
    const subtitle = typeof node.attrs.subtitle === "string" ? node.attrs.subtitle : "";

    return [
      "section",
      mergeAttributes(HTMLAttributes, {
        "data-type": "table-of-contents",
        "data-title": node.attrs.title,
        "data-subtitle": subtitle,
        "data-style": style,
        class: `manuscript-toc manuscript-toc-${style}`
      }),
      ["div", { class: "toc-title" }, node.attrs.title || "目次"],
      ["p", { class: subtitle ? "toc-subtitle" : "toc-subtitle toc-subtitle-empty" }, subtitle],
      [
        "ol",
        { class: "toc-list" },
        ...items.map((item) => [
          "li",
          { class: "toc-entry" },
          ["span", { class: "toc-entry-title" }, item.title],
          ["span", { class: "toc-entry-leader" }, ""],
          ["span", { class: "toc-entry-page" }, item.page === null ? "…" : String(item.page)]
        ])
      ]
    ];
  },

  renderText({ node }) {
    const items = readTocItems(node.attrs.items);
    return [node.attrs.title || "目次", ...items.map((item) => `${item.title} ${item.page ?? ""}`)].join("\n");
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
      width: {
        default: null,
        parseHTML: (element) => (element as HTMLElement).dataset.width ?? (element as HTMLElement).style.width ?? null,
        renderHTML: (attributes) => qrCardWidthAttributes(attributes.width)
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
            width: element.dataset.width ?? element.style.width ?? null
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
