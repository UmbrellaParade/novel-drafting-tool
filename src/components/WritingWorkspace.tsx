"use client";

import { useCallback, useImperativeHandle, useRef, useState, type Ref } from "react";
import { DOMParser as ProseMirrorParser, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { joinWritingSections, splitWritingSections } from "@/lib/writingSections";
import { TiptapEditor } from "./TiptapEditor";

export type WritingWorkspaceHandle = {
  getHTML: () => string;
};

type Props = {
  content: string;
  onChange: (html: string) => void;
  onReady: (editor: Editor | null) => void;
  ref: Ref<WritingWorkspaceHandle>;
};

export function WritingWorkspace({ content, onChange, onReady, ref }: Props) {
  const [sections] = useState(() => splitWritingSections(content));
  const [index, setIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const indexRef = useRef(0);
  const editorRef = useRef<Editor | null>(null);
  const statesRef = useRef(new Map<number, EditorState>());
  const committedDocsRef = useRef(new Map<number, ProseMirrorNode>());
  const assembledRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const readFullContent = useCallback(() => {
    const editor = editorRef.current;
    const current = indexRef.current;
    if (editor && !editor.isDestroyed) {
      statesRef.current.set(current, editor.state);
      if (committedDocsRef.current.get(current) !== editor.state.doc) {
        sections[current].html = editor.getHTML();
        committedDocsRef.current.set(current, editor.state.doc);
        assembledRef.current = null;
      }
    }
    assembledRef.current ??= joinWritingSections(sections);
    return assembledRef.current;
  }, [sections]);

  useImperativeHandle(ref, () => ({
    getHTML: readFullContent,
  }), [readFullContent]);

  const ready = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
    if (editor) committedDocsRef.current.set(indexRef.current, editor.state.doc);
    onReady(editor);
  }, [onReady]);

  const commit = useCallback(() => {
    onChange(readFullContent());
    setRevision((value) => value + 1);
  }, [onChange, readFullContent]);

  const selectSection = (target: number) => {
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || editor.view.composing || target === indexRef.current || !sections[target]) return;
    commit();
    let next = statesRef.current.get(target);
    if (!next) {
      const body = new DOMParser().parseFromString(sections[target].html, "text/html").body;
      next = EditorState.create({
        schema: editor.schema,
        doc: ProseMirrorParser.fromSchema(editor.schema).parse(body),
        plugins: editor.state.plugins,
      });
      committedDocsRef.current.set(target, next.doc);
    }
    indexRef.current = target;
    // The same editor/schema/plugins stay alive. Each window keeps its selection
    // and undo history, but only the selected window has an editable DOM.
    editor.view.updateState(next);
    editor.emit("selectionUpdate", { editor, transaction: next.tr });
    setIndex(target);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const jumpToHeading = (headingIndex: number) => {
    readFullContent();
    let remaining = headingIndex;
    for (let target = 0; target < sections.length; target += 1) {
      const body = new DOMParser().parseFromString(sections[target].html, "text/html").body;
      const count = body.querySelectorAll("h1").length;
      if (remaining < count) {
        selectSection(target);
        const heading = editorRef.current?.view.dom.querySelectorAll("h1")[remaining];
        heading?.scrollIntoView({ block: "start" });
        return;
      }
      remaining -= count;
    }
  };

  return (
    <div className="writing-workspace" data-writing-section={index} data-writing-sections={sections.length} data-writing-revision={revision}>
      <nav className="writing-navigation" aria-label="執筆範囲">
        <button type="button" title="前の範囲" aria-label="前の執筆範囲" disabled={index === 0} onClick={() => selectSection(index - 1)}><ChevronLeft size={17} /></button>
        <select aria-label="編集する範囲" value={index} onChange={(event) => selectSection(Number(event.target.value))}>
          {sections.map((section, sectionIndex) => <option key={sectionIndex} value={sectionIndex}>{sectionIndex + 1}. {section.title}{section.part > 1 ? `（続き ${section.part}）` : ""}</option>)}
        </select>
        <span>{index + 1} / {sections.length}</span>
        <button type="button" title="次の範囲" aria-label="次の執筆範囲" disabled={index === sections.length - 1} onClick={() => selectSection(index + 1)}><ChevronRight size={17} /></button>
      </nav>
      <div className="writing-scroll" ref={scrollRef}>
        <TiptapEditor content={sections[0].html} onChange={commit} onReady={ready} onTableOfContentsLink={jumpToHeading} scrollToSelection boundedDocument />
      </div>
    </div>
  );
}
