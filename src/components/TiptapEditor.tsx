"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import { NodeSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Check,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Pilcrow,
  QrCode,
  Redo2,
  ScissorsLineDashed,
  Trash2,
  Type,
  Undo2,
  X,
  Underline as UnderlineIcon
} from "lucide-react";
import { PageBreakBeforeExtension, PageBreakNode, QrCardNode, RubyTextNode } from "./tiptapExtensions";

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

type ToolbarState = {
  canUndo: boolean;
  canRedo: boolean;
  hasImageSelection: boolean;
  selectedImageWidth: number | null;
};

const IMAGE_SIZE_RATIOS = [0.5, 0.75, 1] as const;

export function TiptapEditor({ content, onChange, onReady }: TiptapEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        horizontalRule: false
      }),
      Underline,
      Image.configure({
        allowBase64: true,
        inline: false,
        resize: {
          enabled: true,
          directions: ["top-left", "top-right", "bottom-left", "bottom-right"],
          minWidth: 48,
          minHeight: 48,
          alwaysPreserveAspectRatio: true
        }
      }),
      TextAlign.configure({
        types: ["heading", "paragraph"]
      }),
      Placeholder.configure({
        placeholder: "本文を書きはじめる"
      }),
      PageBreakBeforeExtension,
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
  const rubyReadingInputRef = useRef<HTMLInputElement | null>(null);
  const [toolbarState, setToolbarState] = useState<ToolbarState>({
    canUndo: false,
    canRedo: false,
    hasImageSelection: false,
    selectedImageWidth: null
  });
  const [rubyPanelOpen, setRubyPanelOpen] = useState(false);
  const [rubyDraft, setRubyDraft] = useState({ base: "", rt: "" });
  const disabled = !editor;

  useEffect(() => {
    if (!editor) {
      setToolbarState({
        canUndo: false,
        canRedo: false,
        hasImageSelection: false,
        selectedImageWidth: null
      });
      return;
    }

    const refreshToolbarState = () => {
      const imageAttributes = editor.getAttributes("image");
      const hasImageSelection = editor.isActive("image") && Boolean(imageAttributes.src);
      setToolbarState({
        canUndo: editor.can().undo(),
        canRedo: editor.can().redo(),
        hasImageSelection,
        selectedImageWidth: hasImageSelection ? parseImageDimension(imageAttributes.width) : null
      });
    };

    refreshToolbarState();
    editor.on("selectionUpdate", refreshToolbarState);
    editor.on("transaction", refreshToolbarState);
    editor.on("update", refreshToolbarState);

    return () => {
      editor.off("selectionUpdate", refreshToolbarState);
      editor.off("transaction", refreshToolbarState);
      editor.off("update", refreshToolbarState);
    };
  }, [editor]);

  const openRubyPanel = () => {
    if (!editor) {
      return;
    }

    const { from, to } = editor.state.selection;
    const rubyAttrs = editor.getAttributes("rubyText") as { base?: string; rt?: string };
    const isRubySelected = editor.isActive("rubyText") && Boolean(rubyAttrs.base || rubyAttrs.rt);
    const selectedText = editor.state.doc.textBetween(from, to, " ").trim();
    setRubyDraft({
      base: isRubySelected ? rubyAttrs.base ?? "" : selectedText,
      rt: isRubySelected ? rubyAttrs.rt ?? "" : ""
    });
    setRubyPanelOpen(true);
    window.requestAnimationFrame(() => rubyReadingInputRef.current?.focus());
  };

  const applyRuby = () => {
    if (!editor) {
      return;
    }

    const base = rubyDraft.base.trim();
    const rt = rubyDraft.rt.trim();
    if (!base || !rt) {
      window.alert("親文字とルビを入力してください。");
      return;
    }

    const chain = editor.chain().focus();
    if (editor.isActive("rubyText")) {
      chain.updateAttributes("rubyText", { base, rt }).run();
    } else {
      chain.deleteSelection().insertContent({ type: "rubyText", attrs: { base, rt } }).run();
    }
    setRubyPanelOpen(false);
  };

  const insertPageBreak = () => {
    if (!editor) {
      return;
    }

    const { selection } = editor.state;
    if (selection instanceof NodeSelection) {
      const shouldEnable = !selection.node.attrs.pageBreakBefore;
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(selection.from, undefined, {
            ...selection.node.attrs,
            pageBreakBefore: shouldEnable
          });
          return true;
        })
        .run();
      return;
    }

    const activeTypeBeforeSplit = currentBreakableNodeName(editor);
    const isAtBlockStart = selection.$from.parentOffset === 0;
    const alreadyBreaksBefore = Boolean(editor.getAttributes(activeTypeBeforeSplit).pageBreakBefore);

    if (isAtBlockStart && alreadyBreaksBefore) {
      editor.chain().focus().updateAttributes(activeTypeBeforeSplit, { pageBreakBefore: false }).run();
      return;
    }

    if (!selection.empty) {
      editor.chain().focus().deleteSelection().run();
    }

    if (editor.state.selection.$from.parentOffset > 0) {
      editor.chain().focus().splitBlock().run();
    }

    editor.chain().focus().updateAttributes(currentBreakableNodeName(editor), { pageBreakBefore: true }).run();
  };

  const handleImageFile = (file: File) => {
    if (!editor) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      editor
        .chain()
        .focus()
        .setImage({
          src,
          alt: file.name,
          title: file.name,
          width: Math.round(readPageWidthPx(editor) * 0.75)
        })
        .run();
    };
    reader.readAsDataURL(file);
  };

  const setImageWidth = (width: number) => {
    if (!editor || !toolbarState.hasImageSelection) {
      return;
    }

    editor.chain().focus().updateAttributes("image", { width: Math.round(width), height: null }).run();
  };

  const setImageWidthRatio = (ratio: (typeof IMAGE_SIZE_RATIOS)[number]) => {
    if (!editor) {
      return;
    }
    setImageWidth(readPageWidthPx(editor) * ratio);
  };

  const setImageToTextWidth = () => {
    if (!editor) {
      return;
    }
    setImageWidth(readCssLengthPx(editor, "--content-width"));
  };

  const setImageToPageWidth = () => {
    if (!editor) {
      return;
    }
    setImageWidth(readPageWidthPx(editor));
  };

  const resetImageSize = () => {
    if (!editor || !toolbarState.hasImageSelection) {
      return;
    }

    editor.chain().focus().updateAttributes("image", { width: null, height: null }).run();
  };

  const deleteSelectedContent = () => {
    if (!editor) {
      return;
    }

    editor.chain().focus().deleteSelection().run();
  };

  const pageWidth = editor ? readPageWidthPx(editor) : 420;
  const imageWidth = toolbarState.selectedImageWidth ?? Math.round(pageWidth * 0.75);
  const maxImageWidth = Math.max(240, Math.round(pageWidth));

  return (
    <>
      <div className="editor-toolbar" aria-label="本文ツールバー">
        <ToolButton label="戻す" disabled={disabled || !toolbarState.canUndo} onClick={() => editor?.chain().focus().undo().run()}>
          <Undo2 size={18} />
        </ToolButton>
        <ToolButton label="進む" disabled={disabled || !toolbarState.canRedo} onClick={() => editor?.chain().focus().redo().run()}>
          <Redo2 size={18} />
        </ToolButton>
        <span className="toolbar-divider" />
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
        <ToolButton label="ルビ" active={rubyPanelOpen} disabled={disabled} onClick={openRubyPanel}>
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
      {rubyPanelOpen ? (
        <div className="ruby-controls" aria-label="ルビ設定">
          <label>
            <span>親文字</span>
            <input value={rubyDraft.base} onChange={(event) => setRubyDraft((draft) => ({ ...draft, base: event.target.value }))} />
          </label>
          <label>
            <span>ルビ</span>
            <input ref={rubyReadingInputRef} value={rubyDraft.rt} onChange={(event) => setRubyDraft((draft) => ({ ...draft, rt: event.target.value }))} />
          </label>
          <button type="button" onClick={applyRuby}>
            <Check size={16} />
            適用
          </button>
          <button type="button" onClick={() => setRubyPanelOpen(false)}>
            <X size={16} />
            閉じる
          </button>
        </div>
      ) : null}
      {toolbarState.hasImageSelection ? (
        <div className="image-size-controls" aria-label="画像サイズ">
          <span className="image-size-chip">画像</span>
          {IMAGE_SIZE_RATIOS.map((ratio) => (
            <button key={ratio} type="button" onClick={() => setImageWidthRatio(ratio)}>
              {Math.round(ratio * 100)}%
            </button>
          ))}
          <button type="button" onClick={setImageToTextWidth}>
            本文幅
          </button>
          <button type="button" onClick={setImageToPageWidth}>
            紙面幅
          </button>
          <input
            className="image-size-range"
            type="range"
            min={48}
            max={maxImageWidth}
            value={Math.max(48, Math.min(maxImageWidth, imageWidth))}
            onChange={(event) => setImageWidth(Number(event.target.value))}
            aria-label="画像幅"
          />
          <input
            className="image-size-number"
            type="number"
            min={48}
            max={maxImageWidth}
            value={Math.round(imageWidth)}
            onChange={(event) => setImageWidth(Number(event.target.value))}
            aria-label="画像幅px"
          />
          <span className="image-size-unit">px</span>
          <button type="button" onClick={resetImageSize}>
            自動
          </button>
          <button className="danger" type="button" onClick={deleteSelectedContent} title="削除" aria-label="削除">
            <Trash2 size={16} />
          </button>
        </div>
      ) : null}
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

function parseImageDimension(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function readPageWidthPx(editor: Editor): number {
  return readCssLengthPx(editor, "--page-width");
}

function readCssLengthPx(editor: Editor, variableName: string): number {
  const host = editor.view.dom.parentElement ?? editor.view.dom;
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.width = `var(${variableName})`;
  probe.style.height = "0";
  host.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return Number.isFinite(width) && width > 0 ? width : 320;
}

function currentBreakableNodeName(editor: Editor): string {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection) {
    return selection.node.type.name;
  }

  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.isBlock) {
      return node.type.name;
    }
  }

  return "paragraph";
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
