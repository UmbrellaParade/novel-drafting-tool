"use client";

import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { DOMSerializer, Fragment } from "@tiptap/pm/model";
import QRCode from "qrcode";
import { TiptapEditor, TiptapToolbar } from "../src/components/TiptapEditor";
import { createDefaultProject, PAGE_PRESETS } from "../src/lib/defaultProject";
import { saveProjectToBrowser } from "../src/lib/storage";

// Mount this fixture in a temporary local Next route, never against a saved manuscript.
export default function EditorBrowserFixture() {
  const [content, setContent] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [report, setReport] = useState("Ready");
  const [htmlLength, setHtmlLength] = useState(0);
  const [vertical, setVertical] = useState(false);
  useEffect(() => {
    void QRCode.toDataURL("https://example.com", { width: 420 }).then((src) => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 400;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#19776f";
      ctx.fillRect(0, 0, 600, 400);
      ctx.fillStyle = "#ffffff";
      ctx.font = "48px sans-serif";
      ctx.fillText("IMAGE TEST", 100, 220);
      const image = `<img src="${canvas.toDataURL()}" width="180" height="120" alt="Test image">`;
      setContent(`<p>入力確認：東京13……―！！。</p>${image}${image}<figure data-type="qr-card" data-title="公式サイト" data-description="QR説明文" data-label="記録室" data-src="${src}" data-url="https://example.com" data-template="archive" data-width="240"></figure><section data-type="horizontal-writing-block"><p>横書き13……―！！。</p></section><p>最後の段落。</p>`);
    });
  }, []);

  const run = async () => {
    if (!editor) return;
    const passed: string[] = [];
    const check = (condition: unknown, label: string) => {
      if (!condition) throw new Error(label);
      passed.push(label);
    };
    setReport("Running");
    try {
      const positions: Record<string, number[]> = { image: [], qrCard: [] };
      editor.state.doc.descendants((node, pos) => { positions[node.type.name]?.push(pos); });
      const qrPos = positions.qrCard[0];
      const qrDom = editor.view.nodeDOM(qrPos) as HTMLElement;
      const qrImage = qrDom.querySelector("img");
      editor.commands.setNodeSelection(qrPos);
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        const node = editor.state.doc.nodeAt(qrPos)!;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(qrPos, undefined, { ...node.attrs, width: 220 + i, height: 180 + i }));
      }
      const qrMs = performance.now() - start;
      check(editor.view.nodeDOM(qrPos) === qrDom && qrDom.querySelector("img") === qrImage, "QR slider: same card and image DOM after 100 updates");
      check(qrDom.dataset.width === "319" && qrDom.dataset.height === "279", "QR dimensions updated");
      check(qrDom.classList.contains("ProseMirror-selectednode"), "QR selection retained");
      const qrNode = editor.state.doc.nodeAt(qrPos)!;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(qrPos, undefined, { ...qrNode.attrs, title: "変更後タイトル", description: "変更後説明", template: "ornate", titleFontSizePt: 15, width: null, height: null }));
      check(qrDom.querySelector(".qr-card-title")?.textContent === "変更後タイトル" && qrImage?.alt === "変更後タイトル", "QR text and image alt updated");
      check(!qrDom.hasAttribute("data-width") && !qrDom.style.width && qrDom.style.getPropertyValue("--qr-title-font-size") === "15pt", "QR auto size and text size updated");
      check(qrDom.classList.contains("qr-card-ornate"), "QR frame updated");
      const replacementSrc = await QRCode.toDataURL("https://example.com/updated", { width: 420 });
      editor.view.dispatch(editor.state.tr.setNodeMarkup(qrPos, undefined, { ...editor.state.doc.nodeAt(qrPos)!.attrs, src: replacementSrc }));
      check(qrDom.querySelector("img") === qrImage && qrImage?.getAttribute("src") === replacementSrc, "QR URL image can change without losing its node view");

      const otherImage = (editor.view.nodeDOM(positions.image[1]) as HTMLElement).querySelector("img")!;
      const changes = new MutationObserver(() => {});
      changes.observe(otherImage, { attributes: true });
      const imagePos = positions.image[0];
      editor.view.dispatch(editor.state.tr.setNodeMarkup(imagePos, undefined, { ...editor.state.doc.nodeAt(imagePos)!.attrs, width: 260, height: null }));
      check(changes.takeRecords().length === 0, "Image resize: unrelated image untouched");
      changes.disconnect();
      const image = (editor.view.nodeDOM(imagePos) as HTMLElement).querySelector("img")!;
      check(image.style.width === "260px" && image.style.height === "auto", "Image dimensions rendered immediately");

      editor.commands.setTextSelection(2);
      editor.commands.insertContent("保存直前入力");
      check(editor.getHTML().includes("保存直前入力"), "Latest typing available before deferred HTML commit");
      const html = editor.getHTML();
      editor.commands.setContent(html);
      check(editor.getHTML() === html, "HTML save/read round trip preserves serialized content and attributes");
      check(!editor.view.dom.querySelector(".horizontal-writing-block .vertical-dash"), "Horizontal block has no vertical decorations");

      const text = "日本語13……―！！。画像やQRのある長編原稿を編集します。";
      const blocks: string[] = [];
      for (let i = 0; i < 1200; i++) blocks.push(`<p>${text.repeat(3)}</p>${i % 30 === 0 ? image.outerHTML + qrDom.outerHTML : ""}`);
      editor.commands.setContent(blocks.join(""));
      const durations: number[] = [];
      for (let i = 0; i < 40; i++) {
        const before = performance.now();
        editor.commands.insertContentAt({ from: 2, to: 3 }, String(i % 10));
        durations.push(performance.now() - before);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      durations.sort((a, b) => a - b);
      check(editor.state.doc.childCount === 1280, "Long document: 1200 paragraphs, 40 images and 40 QR cards retained");
      setReport(JSON.stringify({ passed, qr100UpdatesMs: +qrMs.toFixed(2), browserDispatchMedianMs: +durations[20].toFixed(2), browserDispatchP95Ms: +durations[38].toFixed(2), scope: "Current browser editor dispatch; not end-to-end input-to-paint latency", characters: editor.state.doc.textContent.length }, null, 2));
    } catch (error) {
      setReport(JSON.stringify({ passed, error: String(error) }, null, 2));
    }
  };
  const openLocalApp = async () => {
    if (!editor || location.hostname !== "127.0.0.1") return;
    const nodes: typeof editor.state.doc[] = [];
    editor.state.doc.forEach((node) => { if (nodes.length < 214) nodes.push(node); });
    const container = document.createElement("div");
    container.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(Fragment.from(nodes)));
    const project = createDefaultProject();
    project.title = "性能検証用サンプル";
    project.pageSettings = { ...PAGE_PRESETS["shimauma-a5"].settings, writingMode: "vertical" };
    project.chapters[0].content = container.innerHTML;
    await saveProjectToBrowser(project);
    location.href = "/";
  };
  return <main style={{ padding: 20 }}>
    <h1>Editor performance verification</h1>
    <button onClick={() => void run()} disabled={!editor}>Run checks</button>
    <button onClick={() => setVertical((value) => !value)}>Toggle writing mode</button>
    <button onClick={() => void openLocalApp()} disabled={!editor}>Open local app with sample</button>
    <p>Serialized HTML length: {htmlLength}</p>
    <pre id="test-report" style={{ maxHeight: 250, overflow: "auto", whiteSpace: "pre-wrap" }}>{report}</pre>
    <div className="topbar-editor-tools"><TiptapToolbar editor={editor} verticalWriting={vertical} /></div>
    <div className="page-stage" style={{ height: 500, padding: 16, display: "block", background: "white", "--content-width": "600px", "--content-height": "450px", "--page-width": "650px", "--margin-left": "20px" } as React.CSSProperties}>
      <style>{`.qa-editor .manuscript-prose { columns: auto; width: 600px; height: auto; min-height: 450px; font-size: 16px; line-height: 1.8; writing-mode: ${vertical ? "vertical-rl" : "horizontal-tb"}; }`}</style>
      <div className="qa-editor">{content && <TiptapEditor content={content} onChange={(html) => setHtmlLength(html.length)} onReady={setEditor} />}</div>
    </div>
  </main>;
}
