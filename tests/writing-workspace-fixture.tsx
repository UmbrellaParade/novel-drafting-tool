"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Editor } from "@tiptap/core";
import { DOMParser as ProseMirrorParser } from "@tiptap/pm/model";
import QRCode from "qrcode";
import { WritingWorkspace, type WritingWorkspaceHandle } from "../src/components/WritingWorkspace";
import { TiptapEditor, TiptapToolbar } from "../src/components/TiptapEditor";
import { joinWritingSections, splitWritingSections } from "../src/lib/writingSections";

const pause = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html").body;

export default function WritingWorkspaceFixture() {
  const [html, setHtml] = useState("");
  const [mode, setMode] = useState<"write" | "layout">("write");
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const writer = useRef<WritingWorkspaceHandle | null>(null);
  const [report, setReport] = useState("Ready");
  const ready = useCallback((next: Editor | null) => { editorRef.current = next; setEditor(next); }, []);

  useEffect(() => {
    void QRCode.toDataURL("https://example.com", { width: 300 }).then((src) => {
      const canvas = document.createElement("canvas");
      canvas.width = 600; canvas.height = 300;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#2b7e73"; context.fillRect(0, 0, 600, 300);
      context.fillStyle = "#fff"; context.font = "40px sans-serif"; context.fillText("IMAGE TEST", 100, 170);
      const image = `<img src="${canvas.toDataURL()}" width="200" height="100" alt="検証用画像">`;
      const qr = `<figure data-type="qr-card" data-title="検証用QR" data-url="https://example.com" data-src="${src}" data-width="240" data-template="archive"></figure>`;
      const body = "日本語の長編原稿を検証します。東京13……―！！。写真とルビと文字を保持して、入力と紙面を分けます。";
      const compound = '<section data-type="horizontal-writing-block"><p>横組みの保存確認。</p></section><section data-type="column-block" data-columns="2"><p>歌詞の保存確認</p></section><section data-type="table-of-contents" data-title="目次"></section>';
      setHtml(Array.from({ length: 220 }, (_, index) => `<h1>第${index + 1}章</h1>${Array.from({ length: 8 }, (_, paragraph) => `<p>${index === 0 && paragraph === 0 ? '<ruby>東京<rt>とうきょう</rt></ruby><strong>太字</strong><a href="https://example.com">リンク</a>' : ""}${body.repeat(2)}</p>`).join("")}${index % 5 === 0 ? image + qr : ""}${index === 0 ? compound : ""}<div data-type="page-break"></div>`).join(""));
    });
  }, []);

  const run = async () => {
    if (!writer.current || !editorRef.current) return;
    const passed: string[] = [];
    const check = (condition: unknown, name: string) => { if (!condition) throw new Error(name); passed.push(name); };
    const choose = async (index: number) => {
      const select = document.querySelector<HTMLSelectElement>("select[aria-label='編集する範囲']")!;
      select.value = String(index); select.dispatchEvent(new Event("change", { bubbles: true }));
      await pause();
    };
    const editParagraph = (text: string) => {
      const current = editorRef.current!;
      let position = -1;
      current.state.doc.forEach((node, pos) => { if (position < 0 && node.type.name === "paragraph") position = pos + 1; });
      current.commands.insertContentAt(position, text);
    };
    setReport("Running");
    try {
      const split = splitWritingSections(html);
      check(split.length === 220, "220 chapters partitioned");
      check(joinWritingSections(split) === parse(html).innerHTML, "Untouched HTML reassembled without adding separators");
      const noHeadings = Array.from({ length: 3000 }, () => "<p>見出しのない本文。</p>").join("");
      check(splitWritingSections(noHeadings).every((section) => parse(section.html).children.length <= 48), "No-heading manuscripts bounded to 48 top-level blocks");
      check(splitWritingSections("<h1>長い章</h1>" + Array.from({ length: 90 }, () => `<p>${"文".repeat(400)}</p>`).join("")).every((section) => (parse(section.html).textContent?.length ?? 0) <= 6000), "Long chapters divided into 6000-character editing windows");
      const compound = `<section data-type="horizontal-writing-block"><p>${"長い本文".repeat(1800)}</p></section>`;
      check(splitWritingSections(compound)[0].html === compound, "Oversize compound blocks retained intact");
      check(splitWritingSections("")[0].html === "<p></p>", "Empty manuscript remains editable");
      check(writer.current.getHTML() === parse(html).innerHTML, "Initial read preserves complete manuscript");
      check(editorRef.current!.state.doc.childCount <= 16 && !document.querySelector(".page-frame"), "Only one chapter has an editable DOM");
      editParagraph("保存即時TEST");
      const immediate = parse(writer.current.getHTML());
      check(immediate.textContent?.includes("保存即時TEST") && immediate.querySelectorAll("h1").length === 220, "Immediate full-content read includes pending text and all 220 chapters");
      check(Array.from(immediate.children).filter((node) => node.tagName === "P").length === 1760, "Editing-window boundaries do not add empty paragraphs");
      check(Array.from(immediate.querySelectorAll("img")).filter((image) => !image.closest('[data-type="qr-card"]')).length === 44 && immediate.querySelectorAll('[data-type="qr-card"]').length === 44, "All 44 images and 44 QR cards retained");
      check(immediate.querySelector("ruby rt")?.textContent === "とうきょう" && immediate.querySelector("strong")?.textContent === "太字", "Ruby and marks retained");
      check(immediate.querySelector('[data-type="horizontal-writing-block"]')?.textContent === "横組みの保存確認。" && immediate.querySelector('[data-type="column-block"]')?.textContent === "歌詞の保存確認", "Horizontal-writing and column blocks retained");
      check(immediate.querySelectorAll('[data-type="page-break"]').length === 220 && immediate.querySelectorAll('[data-type="table-of-contents"]').length === 1, "Explicit page breaks and table of contents retained");
      await choose(1);
      editParagraph("別章TEST");
      await choose(0);
      check(editorRef.current!.commands.undo(), "Undo history survives chapter round trip");
      check(!parse(writer.current!.getHTML()).textContent?.includes("保存即時TEST") && parse(writer.current!.getHTML()).textContent?.includes("別章TEST"), "Undo affects only the active chapter");
      check(editorRef.current!.commands.redo(), "Redo survives chapter round trip");
      const current = editorRef.current!;
      current.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "と" }));
      await choose(1);
      check(document.querySelector(".writing-workspace")?.getAttribute("data-writing-section") === "0", "IME composition prevents chapter switching");
      current.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "と" }));
      await pause(100);
      let imagePosition = -1, qrPosition = -1;
      current.state.doc.descendants((node, pos) => {
        if (node.type.name === "image") imagePosition = pos;
        if (node.type.name === "qrCard") qrPosition = pos;
      });
      current.view.dispatch(current.state.tr.setNodeMarkup(imagePosition, undefined, { ...current.state.doc.nodeAt(imagePosition)!.attrs, width: 280, height: 140 }));
      const qrDom = current.view.nodeDOM(qrPosition);
      for (let index = 0; index < 50; index += 1) current.view.dispatch(current.state.tr.setNodeMarkup(qrPosition, undefined, { ...current.state.doc.nodeAt(qrPosition)!.attrs, width: 240 + index, height: 200 }));
      check(current.view.nodeDOM(qrPosition) === qrDom, "QR keeps its DOM across 50 size changes");
      await choose(219);
      editParagraph("最終章TEST");
      const all = writer.current!.getHTML();
      const result = parse(all);
      check(result.querySelector("img")?.getAttribute("width") === "280", "Image resize survives navigation");
      check(result.querySelector('[data-type="qr-card"]')?.getAttribute("data-width") === "289", "QR resize survives navigation");
      check(result.querySelectorAll("h1").length === 220 && result.textContent?.includes("最終章TEST"), "Final chapter edit retains all chapters");
      const restored = ProseMirrorParser.fromSchema(current.schema).parse(result);
      check(restored.textContent.includes("最終章TEST") && restored.textContent.includes("保存即時TEST") && restored.textContent.includes("別章TEST"), "Complete assembled manuscript can be restored by paper editor schema");
      await choose(0);

      const measure = async () => {
        const samples: number[] = [];
        const active = editorRef.current!;
        for (let index = 0; index < 30; index += 1) {
          const start = performance.now();
          active.commands.insertContentAt(1, "a");
          active.view.dom.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(active.view.dom.lastElementChild!);
          range.getClientRects();
          samples.push(performance.now() - start);
          await pause(10);
        }
        const sorted = [...samples].sort((a, b) => a - b);
        return { medianMs: sorted[15], p95Ms: sorted[28], maxMs: sorted[29], samples, blocks: active.state.doc.childCount };
      };
      const writing = await measure();
      setMode("layout");
      await pause(1000);
      check(!!editorRef.current && editorRef.current.state.doc.childCount > 1900, "Full-book baseline editor mounted");
      const layout = await measure();
      setReport(JSON.stringify({ passed, total: passed.length, writing, layout, metric: "Synchronous editing transaction plus forced text layout; not end-to-end IME or input-to-paint latency." }, null, 2));
      setMode("write");
    } catch (error) {
      setReport(JSON.stringify({ passed, error: String(error) }, null, 2));
    }
  };

  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 12, "--paged-content-width": "calc(220 * 470px)", "--page-width": "154mm", "--page-height": "216mm", "--content-width": "470px", "--content-height": "660px", "--column-gap": "70px", "--manuscript-font-family": '"Noto Serif JP", serif', "--manuscript-font-size": "10pt", "--line-height": "1.75", "--paragraph-spacing": "1.2mm", "--image-max-height": "480px", "--image-max-width": "470px" } as CSSProperties}>
      <button type="button" onClick={() => void run()} disabled={!editor || mode !== "write"}>Run writing regression</button>
      <details open><summary>Results</summary><pre id="writing-test-report" style={{ maxHeight: 230, overflow: "auto" }}>{report}</pre></details>
      <TiptapToolbar editor={editor} writingScope={mode === "write"} />
      {html && (mode === "write" ? <WritingWorkspace content={html} ref={writer} onReady={ready} onChange={() => {}} /> : <div className="paged-document is-horizontal" style={{ overflow: "hidden", width: 1100 }}><TiptapEditor content={html} onReady={ready} onChange={() => {}} /></div>)}
    </main>
  );
}
