"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { EditorShell } from "../src/components/EditorShell";
import { createDefaultProject, PAGE_PRESETS } from "../src/lib/defaultProject";
import { loadProjectFromBrowser, saveProjectToBrowser } from "../src/lib/storage";

// Temporary local route only. A separate hostname keeps the user's saved draft isolated.
// Animation-frame timings under browser automation/background tabs are diagnostic,
// not comparable to human input-to-paint latency or the transaction benchmark.
export default function LongManuscriptFixture() {
  const samples = useRef<number[]>([]);
  const inputTasks = useRef<number[]>([]);
  const tasks = useRef<number[]>([]);
  const frames = useRef<object[]>([]);
  const [report, setReport] = useState("");
  const [continuous, setContinuous] = useState(false);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => tasks.current.push(entry.duration));
    });
    observer.observe({ type: "longtask" });
    const frameObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => frames.current.push(entry.toJSON()));
    });
    frameObserver.observe({ type: "long-animation-frame" });
    const keydown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".tiptap") || event.key.length !== 1) return;
      const start = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => samples.current.push(performance.now() - start)));
    };
    const input = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".tiptap")) return;
      const start = performance.now();
      queueMicrotask(() => queueMicrotask(() => inputTasks.current.push(performance.now() - start)));
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("input", input, true);
    return () => { observer.disconnect(); frameObserver.disconnect(); document.removeEventListener("keydown", keydown, true); document.removeEventListener("input", input, true); };
  }, []);
  const load = async (pages: number) => {
    if (location.hostname !== "localhost") throw new Error("Use isolated localhost origin");
    const previous = await loadProjectFromBrowser();
    const defaultProject = createDefaultProject();
    const plain = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s/g, "");
    const untouchedDefault = previous?.title === defaultProject.title && plain(previous.chapters[0]?.content ?? "") === plain(defaultProject.chapters[0].content);
    if (previous && previous.title !== "Long manuscript performance fixture" && !untouchedDefault) throw new Error("Refusing to replace an unrelated manuscript");
    const project = createDefaultProject();
    project.title = "Long manuscript performance fixture";
    project.pageSettings = { ...PAGE_PRESETS["shimauma-a5"].settings };
    const paragraph = "日本語の長編原稿で入力を確かめます。東京13……―！！。文章を書いてからページを確認します。";
    project.chapters[0].content = Array.from({ length: pages }, (_, index) =>
      `<h1>第${index + 1}章</h1>${Array.from({length: 8}, () => `<p>${paragraph.repeat(2)}</p>`).join("")}${index < pages - 1 ? '<div data-type="page-break"></div>' : ''}`
    ).join("");
    flushSync(() => setMounted(false));
    await saveProjectToBrowser(project);
    location.reload();
  };
  const read = () => {
    const values = [...samples.current].sort((a, b) => a-b);
    const inputValues = [...inputTasks.current].sort((a, b) => a-b);
    setReport(JSON.stringify({ samples: values.length, medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.floor(values.length * .95)], maxMs: values.at(-1), inputTasks: { count:inputValues.length, medianMs:inputValues[Math.floor(inputValues.length / 2)], maxMs:inputValues.at(-1) }, longTasks: tasks.current.length, maxLongTaskMs: Math.max(0, ...tasks.current), characters: document.querySelector('.tiptap')?.textContent?.length, pages: document.querySelector('.paged-document')?.getAttribute('data-rendered-pages'), continuous, frames: frames.current.slice(-10) }, null, 2));
  };
  return <>
    {mounted && <EditorShell />}
    <aside style={{position:"fixed", bottom:0, left:0, zIndex:999, background:"white", border:"1px solid #888", padding:8, maxWidth:420}}>
      <button onClick={() => void load(30)}>Load 30 pages</button>{" "}
      <button onClick={() => void load(220)}>Load 220 pages</button>{" "}
      <button onClick={() => { samples.current=[]; inputTasks.current=[]; tasks.current=[]; frames.current=[]; setReport(""); }}>Start sample</button>{" "}
      <button onClick={read}>Read report</button>{" "}
      <button onClick={() => setContinuous(!continuous)}>Diagnostic continuous</button>
      <pre id="latency-report" style={{maxHeight:120, overflow:'auto'}}>{report}</pre>
    </aside>
    {continuous && <style>{`
      .page-stage { display:block !important; background:white !important; }
      .page-viewport { width:100% !important; min-height:0 !important; }
      .paged-document { position:relative !important; top:0 !important; width:100% !important; height:auto !important; min-height:0 !important; overflow:visible !important; clip-path:none !important; transform:none !important; contain:none !important; }
      .page-frame-track,.page-scroll-track,.vertical-page-preview-window { display:none !important; }
      .paged-editor-window { display:contents !important; }
      .paged-editor-layer { position:relative !important; top:0 !important; left:0 !important; width:100% !important; transform:none !important; }
      .manuscript-prose { display:block !important; writing-mode:horizontal-tb !important; font-feature-settings:normal !important; width:100% !important; height:auto !important; min-height:0 !important; columns:auto !important; padding:24px; }
    `}</style>}
  </>;
}
