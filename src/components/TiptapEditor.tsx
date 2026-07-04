"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Pilcrow,
  QrCode,
  ScissorsLineDashed,
  Type,
  Underline as UnderlineIcon
} from "lucide-react";
import { PageBreakNode, QrCardNode, RubyTextNode } from "./tiptapExtensions";

type TiptapEditorProps = {
  content: string;
  onChange: (content: string) => void;
  onReady?: (editor: Editor | null) => void;
};

type TiptapToolbarProps = {
  editor: Editor | null;
  onOpenQrLibrary?: () => void;
};

type ToolButtonProps = {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
};

export function TiptapEditor({ content, onChange, onReady }: TiptapEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        horizontalRule: false
      }),
      Underline,
      Image.configure({
        allowBase64: true,
        inline: false
      }),
      TextAlign.configure({
        types: ["heading", "paragraph"]
      }),
      Placeholder.configure({
        placeholder: "本文を書きはじめる"
      }),
      RubyTextNode,
      PageBreakNode,
      QrCardNode
    ],
    content,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "manuscript-prose"
      }
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    }
  });

  useEffect(() => {
    onReady?.(editor ?? null);
    return () => onReady?.(null);
  }, [editor, onReady]);

  if (!editor) {
    return <div className="editor-loading">読み込み中</div>;
  }

  return (
    <div className="editor-stack">
      <EditorContent editor={editor} />
    </div>
  );
}

export function TiptapToolbar({ editor, onOpenQrLibrary }: TiptapToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const disabled = !editor;

  const insertRuby = () => {
    if (!editor) {
      return;
    }

    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, " ").trim();
    const base = selectedText || window.prompt("ルビを付ける文字", "")?.trim();
    if (!base) {
      return;
    }

    const rt = window.prompt("読み", "")?.trim();
    if (!rt) {
      return;
    }

    editor.chain().focus().deleteSelection().insertContent({ type: "rubyText", attrs: { base, rt } }).run();
  };

  const insertPageBreak = () => {
    if (!editor) {
      return;
    }

    editor.chain().focus().insertContent({ type: "pageBreak" }).run();
  };

  const handleImageFile = (file: File) => {
    if (!editor) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      editor.chain().focus().setImage({ src, alt: file.name, title: file.name }).run();
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <div className="editor-toolbar" aria-label="本文ツールバー">
        <ToolButton label="段落" active={editor?.isActive("paragraph")} disabled={disabled} onClick={() => editor?.chain().focus().setParagraph().run()}>
          <Pilcrow size={18} />
        </ToolButton>
        <ToolButton label="見出し1" active={editor?.isActive("heading", { level: 1 })} disabled={disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 size={18} />
        </ToolButton>
        <ToolButton label="見出し2" active={editor?.isActive("heading", { level: 2 })} disabled={disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 size={18} />
        </ToolButton>
        <span className="toolbar-divider" />
        <ToolButton label="太字" active={editor?.isActive("bold")} disabled={disabled} onClick={() => editor?.chain().focus().toggleBold().run()}>
          <Bold size={18} />
        </ToolButton>
        <ToolButton label="斜体" active={editor?.isActive("italic")} disabled={disabled} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          <Italic size={18} />
        </ToolButton>
        <ToolButton label="下線" active={editor?.isActive("underline")} disabled={disabled} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
          <UnderlineIcon size={18} />
        </ToolButton>
        <ToolButton label="ルビ" disabled={disabled} onClick={insertRuby}>
          <Type size={18} />
        </ToolButton>
        <span className="toolbar-divider" />
        <ToolButton label="左揃え" active={editor?.isActive({ textAlign: "left" })} disabled={disabled} onClick={() => editor?.chain().focus().setTextAlign("left").run()}>
          <AlignLeft size={18} />
        </ToolButton>
        <ToolButton label="中央揃え" active={editor?.isActive({ textAlign: "center" })} disabled={disabled} onClick={() => editor?.chain().focus().setTextAlign("center").run()}>
          <AlignCenter size={18} />
        </ToolButton>
        <ToolButton label="右揃え" active={editor?.isActive({ textAlign: "right" })} disabled={disabled} onClick={() => editor?.chain().focus().setTextAlign("right").run()}>
          <AlignRight size={18} />
        </ToolButton>
        <span className="toolbar-divider" />
        <ToolButton label="箇条書き" active={editor?.isActive("bulletList")} disabled={disabled} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          <List size={18} />
        </ToolButton>
        <ToolButton label="番号付きリスト" active={editor?.isActive("orderedList")} disabled={disabled} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          <ListOrdered size={18} />
        </ToolButton>
        <ToolButton label="画像" disabled={disabled} onClick={() => imageInputRef.current?.click()}>
          <ImagePlus size={18} />
        </ToolButton>
        <ToolButton label="QRリンク" disabled={!onOpenQrLibrary} onClick={() => onOpenQrLibrary?.()}>
          <QrCode size={18} />
        </ToolButton>
        <ToolButton label="改ページ" disabled={disabled} onClick={insertPageBreak}>
          <ScissorsLineDashed size={18} />
        </ToolButton>
      </div>
      <input
        ref={imageInputRef}
        className="hidden"
        type="file"
        accept="image/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            handleImageFile(file);
          }
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

function ToolButton({ label, active, disabled, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "is-active" : ""}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
