import { mergeAttributes, Node } from "@tiptap/core";

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
      url: { default: "" },
      title: { default: "QRリンク" },
      description: { default: "" },
      src: { default: "" },
      template: { default: "umbrella" },
      label: { default: "記録室リンク" }
    };
  },

  parseHTML() {
    return [
      {
        tag: "figure[data-type='qr-card']",
        getAttrs: (node) => {
          const element = node as HTMLElement;
          return {
            url: element.dataset.url ?? "",
            title: element.dataset.title ?? element.querySelector(".qr-card-title")?.textContent ?? "QRリンク",
            description: element.dataset.description ?? element.querySelector(".qr-card-description")?.textContent ?? "",
            src: element.dataset.src ?? element.querySelector("img")?.getAttribute("src") ?? "",
            template: element.dataset.template ?? "umbrella",
            label: element.dataset.label ?? "記録室リンク"
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
          ["span", { class: "qr-card-description" }, node.attrs.description],
          ["small", { class: "qr-card-url" }, node.attrs.url]
        ]
      ]
    ];
  },

  renderText({ node }) {
    return `${node.attrs.title} ${node.attrs.url}`;
  }
});
