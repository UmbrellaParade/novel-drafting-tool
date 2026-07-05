"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
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
  Check,
  Copy,
  Heading1,
  ImagePlus,
  Pilcrow,
  QrCode,
  Redo2,
  RefreshCw,
  Scan,
  ScissorsLineDashed,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { BlockFontSizeExtension, FontSizeMark, PageBreakBeforeExtension, PageBreakNode, QrCardNode, RubyTextNode, TableOfContentsNode } from "./tiptapExtensions";

type TiptapEditorProps = {
  content: string;
  onChange: (content: string) => void;
  onTypingActivity?: () => void;
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
  hasImageSelection: boolean;
  selectedImageWidth: number | null;
  hasQrCardSelection: boolean;
  selectedQrCardWidth: number | null;
};

type ImageReplacementTarget = {
  position: number | null;
  src: string;
  alt: string;
  title: string;
};

const FONT_SIZE_SCOPES = {
  all: new Set(["paragraph", "heading", "blockquote", "listItem"]),
  headings: new Set(["heading"]),
  body: new Set(["paragraph", "blockquote", "listItem"])
} as const;

function preserveEditorSelection(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}

export function TiptapEditor({ content, onChange, onTypingActivity, onReady }: TiptapEditorProps) {
  const editorRef = useRef<Editor | null>(null);
  // onChangeをrefで保持することで、useEditor内クロージャが古い参照を持たないようにする
  const onChangeRef = useRef(onChange);
  const onTypingActivityRef = useRef(onTypingActivity);
  // getHTML()のdebounce用タイマー（画像リサイズ中の連続シリアライズを防止）
  const onUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onTypingActivityRef.current = onTypingActivity;
  }, [onTypingActivity]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        horizontalRule: false
      }),
      Underline,
      FontSizeMark,
      BlockFontSizeExtension,
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
      TableOfContentsNode,
      PageBreakNode,
      QrCardNode
    ],
    content,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "manuscript-prose"
      },
      handleKeyDown: (_view, event) => {
        const isEditingKey =
          event.key.length === 1 ||
          event.key === "Backspace" ||
          event.key === "Delete" ||
          event.key === "Enter" ||
          event.key === "Tab";
        if (isEditingKey) {
          onTypingActivity?.();
        }
        return false;
      },
      handlePaste: (_view, event) => {
        onTypingActivity?.();
        const clipboard = event.clipboardData;
        const pastedEditor = editorRef.current;
        if (!clipboard || !pastedEditor) {
          return false;
        }

        const imageFiles = Array.from(clipboard.files).filter((file) => file.type.startsWith("image/"));
        if (imageFiles.length) {
          event.preventDefault();
          void insertClipboardImageFiles(pastedEditor, imageFiles);
          return true;
        }

        const html = clipboard.getData("text/html");
        if (html && /<img\b/i.test(html)) {
          event.preventDefault();
          void insertPastedHtmlWithImages(pastedEditor, html);
          return true;
        }

        return false;
      }
    },
    onUpdate: ({ editor }) => {
      // 画像リサイズ・テキスト削除など、すべての変更でfastEditingフラグを立てる
      onTypingActivityRef.current?.();

      // getHTML()は重いため、80msのdebounceで連続呼び出しをまとめる
      // （画像を1pxドラッグするたびにシリアライズが走るのを防ぐ）
      if (onUpdateTimerRef.current !== null) {
        clearTimeout(onUpdateTimerRef.current);
      }
      onUpdateTimerRef.current = setTimeout(() => {
        onUpdateTimerRef.current = null;
        onChangeRef.current(editor.getHTML());
      }, 80);
    }
  });

  useEffect(() => {
    editorRef.current = editor ?? null;
    onReady?.(editor ?? null);
    return () => {
      editorRef.current = null;
      onReady?.(null);
    };
  }, [editor, onReady]);

  // コンポーネントアンマウント時にタイマーをクリア
  useEffect(() => {
    return () => {
      if (onUpdateTimerRef.current !== null) {
        clearTimeout(onUpdateTimerRef.current);
      }
    };
  }, []);

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
  const imageSelectionTargetRef = useRef<ImageReplacementTarget | null>(null);
  const imageReplaceTargetRef = useRef<ImageReplacementTarget | null>(null);
  const qrCardSelectionPositionRef = useRef<number | null>(null);
  const rubyReadingInputRef = useRef<HTMLInputElement | null>(null);
  const [toolbarState, setToolbarState] = useState<ToolbarState>({
    hasImageSelection: false,
    selectedImageWidth: null,
    hasQrCardSelection: false,
    selectedQrCardWidth: null
  });
  const [rubyPanelOpen, setRubyPanelOpen] = useState(false);
  const [rubyDraft, setRubyDraft] = useState({ base: "", rt: "" });
  const [textSizePt, setTextSizePt] = useState(9);
  const [qrPresetWidth, setQrPresetWidth] = useState(320);
  const disabled = !editor;

  useEffect(() => {
    if (!editor) {
      setToolbarState({
        hasImageSelection: false,
        selectedImageWidth: null,
        hasQrCardSelection: false,
        selectedQrCardWidth: null
      });
      return;
    }

    let frameHandle: number | null = null;
    const refreshToolbarState = () => {
      const imageAttributes = editor.getAttributes("image");
      const hasImageSelection = editor.isActive("image") && Boolean(imageAttributes.src);
      const qrCardAttributes = editor.getAttributes("qrCard");
      const hasQrCardSelection = editor.isActive("qrCard");
      imageSelectionTargetRef.current = hasImageSelection ? readSelectedImageTarget(editor) : null;
      qrCardSelectionPositionRef.current = hasQrCardSelection ? selectedNodePosition(editor, "qrCard") : null;
      const nextState = {
        hasImageSelection,
        selectedImageWidth: hasImageSelection ? parseImageDimension(imageAttributes.width) : null,
        hasQrCardSelection,
        selectedQrCardWidth: hasQrCardSelection ? parseImageDimension(qrCardAttributes.width) : null
      };
      setToolbarState((previous) => (sameToolbarState(previous, nextState) ? previous : nextState));
    };

    const scheduleRefreshToolbarState = () => {
      if (frameHandle !== null) {
        return;
      }

      frameHandle = window.requestAnimationFrame(() => {
        frameHandle = null;
        refreshToolbarState();
      });
    };

    refreshToolbarState();
    editor.on("selectionUpdate", scheduleRefreshToolbarState);
    editor.on("update", scheduleRefreshToolbarState);
    editor.on("focus", scheduleRefreshToolbarState);
    editor.on("blur", scheduleRefreshToolbarState);

    return () => {
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
      editor.off("selectionUpdate", scheduleRefreshToolbarState);
      editor.off("update", scheduleRefreshToolbarState);
      editor.off("focus", scheduleRefreshToolbarState);
      editor.off("blur", scheduleRefreshToolbarState);
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

  const handleImageFile = (file: File, mode: "insert" | "replace" = "insert") => {
    if (!editor) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      if (mode === "replace") {
        const target = imageReplaceTargetRef.current;
        imageReplaceTargetRef.current = null;
        const position = target ? resolveImagePosition(editor, target) : null;
        const imageNode = position !== null ? editor.state.doc.nodeAt(position) : null;
        const replaced = Boolean(
          position !== null &&
            imageNode &&
            imageNode.type.name === "image" &&
            editor
              .chain()
              .focus()
              .insertContentAt(
                { from: position, to: position + imageNode.nodeSize },
                {
                  type: "image",
                  attrs: {
                    ...imageNode.attrs,
                    src,
                    alt: file.name,
                    title: file.name
                  }
                }
              )
              .run()
        );

        if (!replaced) {
          window.alert("置換する画像をもう一度選択してください。");
        } else if (target) {
          syncRenderedImage(editor, target, { src, alt: file.name, title: file.name });
        }
        return;
      }

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

  const prepareReplaceImage = () => {
    if (!editor || !toolbarState.hasImageSelection) {
      return;
    }

    imageReplaceTargetRef.current = imageSelectionTargetRef.current ?? readSelectedImageTarget(editor);
  };

  const setImageWidth = (width: number) => {
    if (!editor || !toolbarState.hasImageSelection) {
      return;
    }

    const target = readSelectedImageTarget(editor) ?? imageSelectionTargetRef.current;
    const position = target ? resolveImagePosition(editor, target) : selectedImagePosition(editor);
    if (position === null) {
      return;
    }

    editor
      .chain()
      .focus()
      .command(({ state, tr }) => {
        const node = state.doc.nodeAt(position);
        if (!node || node.type.name !== "image") {
          return false;
        }

        tr.setNodeMarkup(position, undefined, { ...node.attrs, width: Math.round(width), height: null }, node.marks);
        return true;
      })
      .run();
  };

  const fitImageToCurrentPage = () => {
    if (!editor || !toolbarState.hasImageSelection) {
      return;
    }

    const image = selectedRenderedImage(editor);
    if (!image) {
      return;
    }

    const rect = image.getBoundingClientRect();
    const frame = currentPageFrame(editor, rect.left);
    if (!frame) {
      setImageWidth(readPageWidthPx(editor));
      return;
    }

    const aspectRatio = image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : Math.max(0.1, rect.width / Math.max(1, rect.height));
    const pageScale = readPageScale(editor);
    const verticalPadding = readCssLengthPx(editor, "--paragraph-spacing") + 8;
    const availableHeight = Math.max(48, (frame.contentBottom - rect.top) / pageScale - verticalPadding);
    const maxByHeight = availableHeight * aspectRatio;
    const maxByWidth = readPageWidthPx(editor);
    setImageWidth(Math.max(48, Math.min(maxByWidth, maxByHeight)));
  };

  const matchPreviousImageSize = () => {
    if (!editor || !toolbarState.hasImageSelection) {
      return;
    }

    const selected = selectedRenderedImage(editor);
    if (!selected) {
      return;
    }

    const images = renderedImages(editor);
    const selectedIndex = images.indexOf(selected);
    const previousImage = selectedIndex > 0 ? images[selectedIndex - 1] : null;
    const width = previousImage ? parseImageDimension(previousImage.style.width || previousImage.getAttribute("width")) ?? Math.round(previousImage.getBoundingClientRect().width) : null;
    if (!width) {
      window.alert("前にある画像が見つかりません。");
      return;
    }

    setImageWidth(width);
  };

  const setQrCardWidth = (width: number) => {
    if (!editor || !toolbarState.hasQrCardSelection) {
      return;
    }

    const nextWidth = Math.max(120, Math.min(readTextWidthPx(editor), Math.round(width)));
    const position = selectedNodePosition(editor, "qrCard") ?? qrCardSelectionPositionRef.current;
    if (position === null) {
      return;
    }

    editor
      .chain()
      .focus()
      .command(({ state, tr }) => {
        const node = state.doc.nodeAt(position);
        if (!node || node.type.name !== "qrCard") {
          return false;
        }

        tr.setNodeMarkup(position, undefined, { ...node.attrs, width: nextWidth }, node.marks);
        return true;
      })
      .run();
  };

  const setQrCardToTextWidth = () => {
    if (!editor) {
      return;
    }
    setQrCardWidth(readTextWidthPx(editor));
  };

  const deleteSelectedContent = () => {
    if (!editor) {
      return;
    }

    const target = readSelectedImageTarget(editor) ?? imageSelectionTargetRef.current;
    const position = target ? resolveImagePosition(editor, target) : null;
    if (toolbarState.hasImageSelection && position !== null) {
      const node = editor.state.doc.nodeAt(position);
      if (node?.type.name === "image") {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.delete(position, position + node.nodeSize);
            return true;
          })
          .run();
        return;
      }
    }

    const qrCardPosition = selectedNodePosition(editor, "qrCard") ?? qrCardSelectionPositionRef.current;
    if (toolbarState.hasQrCardSelection && qrCardPosition !== null) {
      const node = editor.state.doc.nodeAt(qrCardPosition);
      if (node?.type.name === "qrCard") {
        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.delete(qrCardPosition, qrCardPosition + node.nodeSize);
            return true;
          })
          .run();
        return;
      }
    }

    editor.chain().focus().deleteSelection().run();
  };

  const applySelectedTextSize = () => {
    if (!editor) {
      return;
    }

    if (editor.state.selection.empty) {
      window.alert("文字サイズを変える範囲をドラッグで選択してください。");
      return;
    }

    editor.chain().focus().setMark("fontSize", { size: `${textSizePt}pt` }).run();
  };

  const applyBlockTextSize = (scope: keyof typeof FONT_SIZE_SCOPES) => {
    if (!editor) {
      return;
    }

    const fontSize = `${textSizePt}pt`;
    const targets = FONT_SIZE_SCOPES[scope];
    editor
      .chain()
      .focus()
      .command(({ state, tr }) => {
        let changed = false;
        state.doc.descendants((node, position) => {
          if (!targets.has(node.type.name)) {
            return;
          }

          tr.setNodeMarkup(position, undefined, { ...node.attrs, fontSize }, node.marks);
          changed = true;
        });
        return changed;
      })
      .run();
  };

  const pageWidth = editor ? readPageWidthPx(editor) : 420;
  const imageWidth = toolbarState.selectedImageWidth ?? Math.round(pageWidth * 0.75);
  const maxImageWidth = Math.max(240, Math.round(pageWidth));
  const textWidth = editor ? readTextWidthPx(editor) : 360;
  const qrCardWidth = toolbarState.selectedQrCardWidth ?? Math.round(textWidth * 0.75);
  const maxQrCardWidth = Math.max(180, Math.round(textWidth));
  const normalizedQrPresetWidth = Math.max(120, Math.min(maxQrCardWidth, Math.round(qrPresetWidth)));

  return (
    <>
      <div className="editor-toolbar" aria-label="本文ツールバー">
        <ToolButton label="戻す" disabled={disabled} onClick={() => editor?.chain().focus().undo().run()}>
          <Undo2 size={18} />
        </ToolButton>
        <ToolButton label="進む" disabled={disabled} onClick={() => editor?.chain().focus().redo().run()}>
          <Redo2 size={18} />
        </ToolButton>
        <span className="toolbar-divider" />
        <ToolButton label="段落" active={editor?.isActive("paragraph")} disabled={disabled} onClick={() => editor?.chain().focus().setParagraph().run()}>
          <Pilcrow size={18} />
        </ToolButton>
        <ToolButton label="見出し1" active={editor?.isActive("heading", { level: 1 })} disabled={disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 size={18} />
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
          <button type="button" onMouseDown={preserveEditorSelection} onClick={fitImageToCurrentPage}>
            <Scan size={15} />
            ページ内最大
          </button>
          <button type="button" onMouseDown={preserveEditorSelection} onClick={matchPreviousImageSize}>
            <Copy size={15} />
            前画像と同じ
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
          <label className="image-replace-button" onPointerDown={prepareReplaceImage}>
            <RefreshCw size={15} />
            置換
            <input
              className="hidden"
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  imageReplaceTargetRef.current = imageReplaceTargetRef.current ?? imageSelectionTargetRef.current ?? (editor ? readSelectedImageTarget(editor) : null);
                  handleImageFile(file, "replace");
                } else {
                  imageReplaceTargetRef.current = null;
                }
                event.currentTarget.value = "";
              }}
            />
          </label>
          <button className="danger" type="button" onMouseDown={preserveEditorSelection} onClick={deleteSelectedContent} title="削除" aria-label="削除">
            <Trash2 size={16} />
          </button>
        </div>
      ) : null}
      {toolbarState.hasQrCardSelection ? (
        <div className="image-size-controls" aria-label="QRカードサイズ">
          <span className="image-size-chip">QRカード</span>
          <button type="button" onMouseDown={preserveEditorSelection} onClick={setQrCardToTextWidth}>
            本文幅
          </button>
          <button type="button" onMouseDown={preserveEditorSelection} onClick={() => setQrCardWidth(normalizedQrPresetWidth)}>
            指定px
          </button>
          <input
            className="image-size-range"
            type="range"
            min={120}
            max={maxQrCardWidth}
            value={Math.max(120, Math.min(maxQrCardWidth, qrCardWidth))}
            onChange={(event) => setQrCardWidth(Number(event.target.value))}
            aria-label="QRカード幅"
          />
          <input
            className="image-size-number"
            type="number"
            min={120}
            max={maxQrCardWidth}
            value={Math.round(qrCardWidth)}
            onChange={(event) => setQrCardWidth(Number(event.target.value))}
            aria-label="QRカード幅px"
          />
          <span className="image-size-unit">px</span>
          <input
            className="image-size-number"
            type="number"
            min={120}
            max={maxQrCardWidth}
            value={normalizedQrPresetWidth}
            onChange={(event) => setQrPresetWidth(Number(event.target.value))}
            aria-label="QRカード指定px"
          />
          <button className="danger" type="button" onMouseDown={preserveEditorSelection} onClick={deleteSelectedContent} title="削除" aria-label="削除">
            <Trash2 size={16} />
          </button>
        </div>
      ) : null}
      <div className="text-size-controls" aria-label="文字サイズ">
        <span className="image-size-chip">文字pt</span>
        <input
          className="text-size-number"
          type="number"
          min={4}
          max={72}
          step={0.1}
          value={textSizePt}
          onChange={(event) => setTextSizePt(Number(event.target.value))}
          aria-label="文字サイズpt"
        />
        <button type="button" onMouseDown={preserveEditorSelection} onClick={applySelectedTextSize}>選択</button>
        <button type="button" onMouseDown={preserveEditorSelection} onClick={() => applyBlockTextSize("all")}>全部</button>
        <button type="button" onMouseDown={preserveEditorSelection} onClick={() => applyBlockTextSize("headings")}>見出し</button>
        <button type="button" onMouseDown={preserveEditorSelection} onClick={() => applyBlockTextSize("body")}>本文</button>
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

function parseImageDimension(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function sameToolbarState(left: ToolbarState, right: ToolbarState): boolean {
  return (
    left.hasImageSelection === right.hasImageSelection &&
    left.selectedImageWidth === right.selectedImageWidth &&
    left.hasQrCardSelection === right.hasQrCardSelection &&
    left.selectedQrCardWidth === right.selectedQrCardWidth
  );
}

async function insertClipboardImageFiles(editor: Editor, files: File[]): Promise<void> {
  for (const file of files) {
    const src = await fileToDataUrl(file);
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
  }
}

async function insertPastedHtmlWithImages(editor: Editor, html: string): Promise<void> {
  const template = document.createElement("template");
  template.innerHTML = html;
  const images = Array.from(template.content.querySelectorAll<HTMLImageElement>("img"));
  await Promise.all(
    images.map(async (image, index) => {
      const src = image.getAttribute("src");
      if (!src) {
        return;
      }

      image.setAttribute("src", await toEmbeddableImageSrc(src));
      image.setAttribute("alt", image.getAttribute("alt") || image.getAttribute("title") || `貼り付け画像 ${index + 1}`);
      image.setAttribute("title", image.getAttribute("title") || image.getAttribute("alt") || `貼り付け画像 ${index + 1}`);
    })
  );

  editor.chain().focus().insertContent(template.innerHTML).run();
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

async function toEmbeddableImageSrc(src: string): Promise<string> {
  if (src.startsWith("data:") || src.startsWith("blob:")) {
    return src;
  }

  try {
    const response = await fetch(src, { mode: "cors", credentials: "include" });
    if (!response.ok) {
      return src;
    }

    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
      return src;
    }

    return await fileToDataUrl(new File([blob], "pasted-image", { type: blob.type }));
  } catch {
    return src;
  }
}

function readPageWidthPx(editor: Editor): number {
  const frame = editor.view.dom.closest(".page-stage")?.querySelector<HTMLElement>(".page-frame");
  const width = frame?.offsetWidth ?? 0;
  return Number.isFinite(width) && width > 0 ? width : readCssLengthPx(editor, "--page-width");
}

function readTextWidthPx(editor: Editor): number {
  const guide = editor.view.dom.closest(".page-stage")?.querySelector<HTMLElement>(".page-safe-guide");
  const width = guide?.offsetWidth ?? 0;
  return Number.isFinite(width) && width > 0 ? width : readCssLengthPx(editor, "--content-width");
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
  const width = probe.offsetWidth || probe.getBoundingClientRect().width;
  probe.remove();
  return Number.isFinite(width) && width > 0 ? width : 320;
}

function readPageScale(editor: Editor): number {
  const viewport = editor.view.dom.closest(".page-viewport");
  if (!viewport) {
    return 1;
  }

  const parsed = Number.parseFloat(window.getComputedStyle(viewport).getPropertyValue("--page-scale"));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function renderedImages(editor: Editor): HTMLImageElement[] {
  return Array.from(editor.view.dom.querySelectorAll<HTMLImageElement>("img:not(.qr-card-image)"));
}

function selectedRenderedImage(editor: Editor): HTMLImageElement | null {
  const target = readSelectedImageTarget(editor);
  const images = renderedImages(editor);
  if (!target) {
    return images.find((image) => image.closest(".ProseMirror-selectednode")) ?? null;
  }

  return (
    images.find((image) => image.getAttribute("src") === target.src && image.getAttribute("title") === target.title) ??
    images.find((image) => image.getAttribute("src") === target.src) ??
    images.find((image) => image.closest(".ProseMirror-selectednode")) ??
    null
  );
}

function currentPageFrame(editor: Editor, x: number): { contentBottom: number } | null {
  const stage = editor.view.dom.closest(".page-stage");
  const frames = Array.from(stage?.querySelectorAll<HTMLElement>(".page-frame") ?? []);
  const firstFrame = frames[0];
  if (!firstFrame) {
    return null;
  }

  const pagePitch = frames[1] ? frames[1].offsetLeft - firstFrame.offsetLeft : firstFrame.offsetWidth;
  if (pagePitch <= 0) {
    return null;
  }

  const firstLeft = firstFrame.getBoundingClientRect().left;
  const pageIndex = Math.max(0, Math.min(frames.length - 1, Math.floor((x - firstLeft + 2) / pagePitch)));
  const frame = frames[pageIndex];
  const guide = frame.querySelector<HTMLElement>(".page-safe-guide");
  if (guide) {
    return {
      contentBottom: guide.getBoundingClientRect().bottom
    };
  }

  const frameRect = frame.getBoundingClientRect();
  const marginTop = readCssLengthPx(editor, "--margin-top");
  const contentHeight = readCssLengthPx(editor, "--content-height");
  const scale = readPageScale(editor);

  return {
    contentBottom: frameRect.top + (marginTop + contentHeight) * scale
  };
}

function selectedImagePosition(editor: Editor): number | null {
  const { selection } = editor.state;
  if (selection instanceof NodeSelection && selection.node.type.name === "image") {
    return selection.from;
  }

  const attrs = editor.getAttributes("image") as { src?: unknown };
  const targetSrc = typeof attrs.src === "string" ? attrs.src : "";
  let closestPosition: number | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== "image" || (targetSrc && node.attrs.src !== targetSrc)) {
      return;
    }

    const distance = Math.abs(position - selection.from);
    if (distance < closestDistance) {
      closestPosition = position;
      closestDistance = distance;
    }
  });

  return closestPosition;
}

function selectedNodePosition(editor: Editor, nodeName: string): number | null {
  const { selection } = editor.state;
  return selection instanceof NodeSelection && selection.node.type.name === nodeName ? selection.from : null;
}

function readSelectedImageTarget(editor: Editor): ImageReplacementTarget | null {
  const attrs = editor.getAttributes("image") as { src?: unknown; alt?: unknown; title?: unknown };
  const src = typeof attrs.src === "string" ? attrs.src : "";
  if (!src) {
    return null;
  }

  return {
    position: selectedImagePosition(editor),
    src,
    alt: typeof attrs.alt === "string" ? attrs.alt : "",
    title: typeof attrs.title === "string" ? attrs.title : ""
  };
}

function resolveImagePosition(editor: Editor, target: ImageReplacementTarget): number | null {
  const currentNode = target.position !== null ? editor.state.doc.nodeAt(target.position) : null;
  if (currentNode?.type.name === "image" && currentNode.attrs.src === target.src) {
    return target.position;
  }

  let position: number | null = null;
  editor.state.doc.descendants((node, candidatePosition) => {
    if (position !== null || node.type.name !== "image") {
      return;
    }

    const sameSrc = target.src && node.attrs.src === target.src;
    const sameAlt = target.alt && node.attrs.alt === target.alt;
    const sameTitle = target.title && node.attrs.title === target.title;
    if (sameSrc || sameAlt || sameTitle) {
      position = candidatePosition;
    }
  });

  return position;
}

function syncRenderedImage(editor: Editor, target: ImageReplacementTarget, next: { src: string; alt: string; title: string }): void {
  const images = Array.from(editor.view.dom.querySelectorAll<HTMLImageElement>("img:not(.qr-card-image)"));
  const image =
    images.find((candidate) => candidate.getAttribute("src") === target.src && candidate.getAttribute("title") === target.title) ??
    images.find((candidate) => candidate.getAttribute("src") === target.src);

  if (!image) {
    return;
  }

  image.setAttribute("src", next.src);
  image.setAttribute("alt", next.alt);
  image.setAttribute("title", next.title);
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
      onMouseDown={preserveEditorSelection}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
