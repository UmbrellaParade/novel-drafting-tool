export type WritingSection = {
  html: string;
  title: string;
  part: number;
};

// Keep compound nodes (ruby, lists, columns, cards) intact. These boundaries are
// editing windows, not chapter boundaries or page breaks in the saved manuscript.
export function splitWritingSections(html: string, maxCharacters = 6000, maxBlocks = 48): WritingSection[] {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  const sections: WritingSection[] = [];
  let nodes: string[] = [];
  let characters = 0;
  let blocks = 0;
  let title = "冒頭";
  let part = 1;
  const flush = () => {
    if (!nodes.length) return;
    sections.push({ html: nodes.join(""), title, part });
    nodes = [];
    characters = 0;
    blocks = 0;
  };
  for (const node of Array.from(body.childNodes)) {
    const element = node.nodeType === 1 ? node as HTMLElement : null;
    const size = node.textContent?.length ?? 0;
    if (element?.tagName === "H1") {
      flush();
      const label = element.cloneNode(true) as HTMLElement;
      label.querySelectorAll("rt, rp").forEach((ruby) => ruby.remove());
      title = label.textContent?.trim() || "見出し";
      part = 1;
    } else if (blocks && (characters + size > maxCharacters || blocks >= maxBlocks)) {
      flush();
      part += 1;
    }
    const wrapper = body.ownerDocument.createElement("div");
    wrapper.append(node.cloneNode(true));
    nodes.push(wrapper.innerHTML);
    characters += size;
    if (element) blocks += 1;
  }
  flush();
  return sections.length ? sections : [{ html: "<p></p>", title, part }];
}

export function joinWritingSections(sections: readonly WritingSection[]): string {
  return sections.map((section) => section.html).join("");
}
