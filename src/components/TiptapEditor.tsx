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
  QrCode,
  Redo2,
  RefreshCw,
  Scan,
  ScissorsLineDashed,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { BlockFontSizeExtension, BlockLineHeightExtension, FontSizeMark, PageBreakBeforeExtension, PageBreakNode, QrCardNode, RubyTextNode, TableOfContentsNode } from "./tiptapExtensions";

type TiptapEditorProps = {
  content: string;
  onChange: (content: string) => void;
  onTypingActivity?: () => void;
  onPasteLayoutHints?: (hints: PasteLayoutHints) => void;
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
  selectedQrCardHeight: number | null;
};

type ImageReplacementTarget = {
  position: number | null;
  src: string;
  alt: string;
  title: string;
};

export type PasteLayoutHints = {
  fontSizePt?: number;
  lineHeight?: number;
  paragraphSpacingMm?: number;
};

const FONT_SIZE_SCOPES = {
  all: new Set(["paragraph", "heading", "blockquote", "listItem"]),
  headings: new Set(["heading"]),
  body: new Set(["paragraph", "blockquote", "listItem"])
} as const;

const LINE_HEIGHT_BLOCK_TYPES = new Set(["paragraph", "heading", "blockquote", "listItem"]);
const EDITOR_HTML_COMMIT_DELAY_MS = 2400;
const EDITOR_HTML_BLUR_COMMIT_DELAY_MS = 250;
const EDITOR_HTML_IDLE_TIMEOUT_MS = 3200;
const IMAGE_FIT_PADDING_PX = 8;

function preserveEditorSelection(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}

export function TiptapEditor({ content, onChange, onTypingActivity, onPasteLayoutHints, onReady }: TiptapEditorProps) {
  const editorRef = useRef<Editor | null>(null);
  // onChangeをrefで保持することで、useEditor内クロージャが古い参照を持たないようにする
  const onChangeRef = useRef(onChange);
  const onTypingActivityRef = useRef(onTypingActivity);
  const onPasteLayoutHintsRef = useRef(onPasteLayoutHints);
  const lastDirectTypingActivityRef = useRef(0);
  // getHTML()のdebounce用タイマー（画像リサイズ中の連続シリアライズを防止）
  const onUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUpdateIdleRef = useRef<number | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onTypingActivityRef.current = onTypingActivity;
  }, [onTypingActivity]);

  useEffect(() => {
    onPasteLayoutHintsRef.current = onPasteLayoutHints;
  }, [onPasteLayoutHints]);

  const clearScheduledHtmlCommit = () => {
    if (onUpdateTimerRef.current !== null) {
      clearTimeout(onUpdateTimerRef.current);
      onUpdateTimerRef.current = null;
    }
    if (onUpdateIdleRef.current !== null) {
      window.cancelIdleCallback?.(onUpdateIdleRef.current);
      onUpdateIdleRef.current = null;
    }
  };

  const scheduleHtmlCommit = (updatedEditor: Editor, delayMs = EDITOR_HTML_COMMIT_DELAY_MS) => {
    clearScheduledHtmlCommit();
    onUpdateTimerRef.current = setTimeout(() => {
      onUpdateTimerRef.current = null;
      const commitHtml = () => {
        onUpdateIdleRef.current = null;
        onChangeRef.current(updatedEditor.getHTML());
      };
      if (window.requestIdleCallback) {
        onUpdateIdleRef.current = window.requestIdleCallback(commitHtml, { timeout: EDITOR_HTML_IDLE_TIMEOUT_MS });
      } else {
        commitHtml();
      }
    }, delayMs);
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        horizontalRule: false
      }),
      Underline,
      FontSizeMark,
      BlockFontSizeExtension,
      BlockLineHeightExtension,
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
        autocapitalize: "off",
        autocomplete: "off",
        autocorrect: "off",
        class: "manuscript-prose",
        "data-gramm": "false",
        lang: "ja",
        spellcheck: "false"
      },
      handleKeyDown: (_view, event) => {
        const isEditingKey =
          event.key.length === 1 ||
          event.key === "Backspace" ||
          event.key === "Delete" ||
          event.key === "Enter" ||
          event.key === "Tab";
        if (isEditingKey) {
          lastDirectTypingActivityRef.current = Date.now();
          onTypingActivity?.();
        }
        return false;
      },
      handleScrollToSelection: () => true,
      handlePaste: (_view, event) => {
        lastDirectTypingActivityRef.current = Date.now();
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
        const layoutHints = html ? readGoogleDocsLayoutHints(html) : null;
        if (layoutHints) {
          onPasteLayoutHintsRef.current?.(layoutHints);
        }
        if (html && /<img\b/i.test(html)) {
          event.preventDefault();
          void insertPastedHtmlWithImages(pastedEditor, html);
          return true;
        }

        return false;
      }
    },
    onUpdate: ({ editor, transaction }) => {
      // キー入力直後のupdateでは同じ通知を二重に走らせない。
      if (!transaction.getMeta("skipTypingActivity") && Date.now() - lastDirectTypingActivityRef.current > 120) {
        onTypingActivityRef.current?.();
      }

      // getHTML() can serialize tens of MB when images are embedded, so never do it
      // directly inside the editing transaction.
      scheduleHtmlCommit(editor);
    },
    onBlur: ({ editor }) => {
      scheduleHtmlCommit(editor, EDITOR_HTML_BLUR_COMMIT_DELAY_MS);
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
      clearScheduledHtmlCommit();
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
    selectedQrCardWidth: null,
    selectedQrCardHeight: null
  });
  const [rubyPanelOpen, setRubyPanelOpen] = useState(false);
  const [rubyDraft, setRubyDraft] = useState({ base: "", rt: "" });
  const [textSizePt, setTextSizePt] = useState(9);
  const [lineHeightValue, setLineHeightValue] = useState(1.75);
  const [qrPresetWidth, setQrPresetWidth] = useState(320);
  const [imageWidthDraft, setImageWidthDraft] = useState("");
  const imageWidthInputFocusedRef = useRef(false);
  const disabled = !editor;

  useEffect(() => {
    if (!editor) {
      setToolbarState({
        hasImageSelection: false,
        selectedImageWidth: null,
        hasQrCardSelection: false,
        selectedQrCardWidth: null,
        selectedQrCardHeight: null
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
        selectedQrCardWidth: hasQrCardSelection ? parseImageDimension(qrCardAttributes.width) : null,
        selectedQrCardHeight: hasQrCardSelection ? parseImageDimension(qrCardAttributes.height) : null
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
    const scheduleSelectedMediaRefresh = () => {
      if (imageSelectionTargetRef.current || qrCardSelectionPositionRef.current !== null) {
        scheduleRefreshToolbarState();
      }
    };

    refreshToolbarState();
    editor.on("selectionUpdate", scheduleRefreshToolbarState);
    editor.on("update", scheduleSelectedMediaRefresh);
    editor.on("focus", scheduleRefreshToolbarState);
    editor.on("blur", scheduleRefreshToolbarState);

    return () => {
      if (frameHandle !== null) {
        window.cancelAnimationFrame(frameHandle);
      }
      editor.off("selectionUpdate", scheduleRefreshToolbarState);
      editor.off("update", scheduleSelectedMediaRefresh);
      editor.off("focus", scheduleRefreshToolbarState);
      editor.off("blur", scheduleRefreshToolbarState);
    };
  }, [editor]);

  useEffect(() => {
    if (imageWidthInputFocusedRef.current) {
      return;
    }

    setImageWidthDraft(toolbarState.hasImageSelection && toolbarState.selectedImageWidth ? String(toolbarState.selectedImageWidth) : "");
  }, [toolbarState.hasImageSelection, toolbarState.selectedImageWidth]);

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

    const imageTarget = toolbarState.hasImageSelection ? readSelectedImageTarget(editor) ?? imageSelectionTargetRef.current : null;
    const imagePosition = imageTarget ? resolveImagePosition(editor, imageTarget) : null;
    if (imagePosition !== null) {
      const imageNode = editor.state.doc.nodeAt(imagePosition);
      if (imageNode?.type.name === "image") {
        withStablePageStageScroll(editor, () => {
          editor
            .chain()
            .focus()
            .command(({ tr }) => {
              tr.setNodeMarkup(imagePosition, undefined, {
                ...imageNode.attrs,
                pageBreakBefore: !imageNode.attrs.pageBreakBefore
              }, imageNode.marks);
              return true;
            })
            .run();
        });
        return;
      }
    }

    const qrCardPosition = toolbarState.hasQrCardSelection ? selectedNodePosition(editor, "qrCard") ?? qrCardSelectionPositionRef.current : null;
    if (qrCardPosition !== null) {
      const qrCardNode = editor.state.doc.nodeAt(qrCardPosition);
      if (qrCardNode?.type.name === "qrCard") {
        withStablePageStageScroll(editor, () => {
          editor
            .chain()
            .focus()
            .command(({ tr }) => {
              tr.setNodeMarkup(qrCardPosition, undefined, {
                ...qrCardNode.attrs,
                pageBreakBefore: !qrCardNode.attrs.pageBreakBefore
              }, qrCardNode.marks);
              return true;
            })
            .run();
        });
        return;
      }
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
        const replaced = withStablePageStageScroll(
          editor,
          () =>
            Boolean(
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
            )
        );

        if (!replaced) {
          window.alert("置換する画像をもう一度選択してください。");
        } else if (target) {
          syncRenderedImage(editor, target, { src, alt: file.name, title: file.name });
        }
        return;
      }

      withStablePageStageScroll(editor, () => {
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
      });
    };
    reader.readAsDataURL(file);
  };

  const prepareReplaceImage = () => {
    if (!editor || !toolbarState.hasImageSelection) {
      return;
    }

    imageReplaceTargetRef.current = imageSelectionTargetRef.current ?? readSelectedImageTarget(editor);
  };

  const setImageWidth = (width: number, options: { respectCurrentPage?: boolean } = {}): number | null => {
    if (!editor || !toolbarState.hasImageSelection) {
      return null;
    }

    const target = readSelectedImageTarget(editor) ?? imageSelectionTargetRef.current;
    const position = target ? resolveImagePosition(editor, target) : selectedImagePosition(editor);
    if (position === null) {
      return null;
    }

    const image = target ? selectedRenderedImageByTarget(editor, target) : renderedImageAtPosition(editor, position) ?? selectedRenderedImage(editor);
    const maxWidth = options.respectCurrentPage === false ? readMaximumImageWidth(editor, image) : readMaximumImageWidthForCurrentPage(editor, image);
    const nextWidth = Math.max(48, Math.min(maxWidth, Math.round(width)));
    const applied = withStablePageStageScroll(editor, () =>
      editor
        .chain()
        .focus()
        .command(({ state, tr }) => {
          const node = state.doc.nodeAt(position);
          if (!node || node.type.name !== "image") {
            return false;
          }

          tr.setNodeMarkup(position, undefined, { ...node.attrs, width: nextWidth, height: null }, node.marks);
          return true;
        })
        .run()
    );
    if (applied) {
      imageSelectionTargetRef.current = target ?? readSelectedImageTarget(editor);
      syncRenderedImageWidth(editor, target, nextWidth);
      window.requestAnimationFrame(() => syncRenderedImageWidth(editor, target, nextWidth));
      setToolbarState((previous) => (previous.hasImageSelection ? { ...previous, selectedImageWidth: nextWidth } : previous));
      setImageWidthDraft(String(nextWidth));
      return nextWidth;
    }

    return null;
  };

  const fitImageToCurrentPage = () => {
    if (!editor || !toolbarState.hasImageSelection) {
      return;
    }

    const image = selectedRenderedImage(editor);
    if (!image) {
      return;
    }

    setImageWidth(readMaximumImageWidthForCurrentPage(editor, image));
  };

  const matchPreviousImageSize = () => {
    if (!editor || !toolbarState.hasImageSelection) {
      return;
    }

    const target = readSelectedImageTarget(editor) ?? imageSelectionTargetRef.current;
    const position = target ? resolveImagePosition(editor, target) : selectedImagePosition(editor);
    const width = position === null ? null : previousImageWidth(editor, position);
    if (!width) {
      window.alert("前にある画像が見つかりません。");
      return;
    }

    setImageWidth(width, { respectCurrentPage: false });
  };

  const commitImageWidthDraft = () => {
    imageWidthInputFocusedRef.current = false;
    const parsed = Number(imageWidthDraft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setImageWidthDraft(String(Math.round(imageWidth)));
      return;
    }

    const appliedWidth = setImageWidth(parsed);
    if (!appliedWidth) {
      setImageWidthDraft(String(Math.round(imageWidth)));
    }
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

    const applied = withStablePageStageScroll(editor, () =>
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
        .run()
    );
    if (applied) {
      setToolbarState((previous) => (previous.hasQrCardSelection ? { ...previous, selectedQrCardWidth: nextWidth } : previous));
    }
  };

  const setQrCardToTextWidth = () => {
    if (!editor) {
      return;
    }
    setQrCardWidth(readTextWidthPx(editor));
  };

  const setQrCardHeight = (height: number | null) => {
    if (!editor || !toolbarState.hasQrCardSelection) {
      return;
    }

    const nextHeight = height === null ? null : Math.max(96, Math.min(readTextHeightPx(editor), Math.round(height)));
    const position = selectedNodePosition(editor, "qrCard") ?? qrCardSelectionPositionRef.current;
    if (position === null) {
      return;
    }

    const applied = withStablePageStageScroll(editor, () =>
      editor
        .chain()
        .focus()
        .command(({ state, tr }) => {
          const node = state.doc.nodeAt(position);
          if (!node || node.type.name !== "qrCard") {
            return false;
          }

          tr.setNodeMarkup(position, undefined, { ...node.attrs, height: nextHeight }, node.marks);
          return true;
        })
        .run()
    );
    if (applied) {
      setToolbarState((previous) => (previous.hasQrCardSelection ? { ...previous, selectedQrCardHeight: nextHeight } : previous));
    }
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
        withStablePageStageScroll(editor, () => {
          editor
            .chain()
            .focus()
            .command(({ tr }) => {
              tr.delete(position, position + node.nodeSize);
              return true;
            })
            .run();
        });
        return;
      }
    }

    const qrCardPosition = selectedNodePosition(editor, "qrCard") ?? qrCardSelectionPositionRef.current;
    if (toolbarState.hasQrCardSelection && qrCardPosition !== null) {
      const node = editor.state.doc.nodeAt(qrCardPosition);
      if (node?.type.name === "qrCard") {
        withStablePageStageScroll(editor, () => {
          editor
            .chain()
            .focus()
            .command(({ tr }) => {
              tr.delete(qrCardPosition, qrCardPosition + node.nodeSize);
              return true;
            })
            .run();
        });
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
        const fontSizeMark = state.schema.marks.fontSize;
        state.doc.descendants((node, position) => {
          if (!targets.has(node.type.name)) {
            return;
          }

          if (fontSizeMark) {
            tr.removeMark(position, position + node.nodeSize, fontSizeMark);
          }
          tr.setNodeMarkup(position, undefined, { ...node.attrs, fontSize }, node.marks);
          changed = true;
        });
        return changed;
      })
      .run();
  };

  const clearTextSizes = () => {
    if (!editor) {
      return;
    }

    const targets = FONT_SIZE_SCOPES.all;
    editor
      .chain()
      .focus()
      .command(({ state, tr }) => {
        let changed = false;
        const fontSizeMark = state.schema.marks.fontSize;
        if (fontSizeMark) {
          tr.removeMark(0, state.doc.content.size, fontSizeMark);
          changed = true;
        }

        state.doc.descendants((node, position) => {
          if (!targets.has(node.type.name) || !node.attrs.fontSize) {
            return;
          }

          tr.setNodeMarkup(position, undefined, { ...node.attrs, fontSize: null }, node.marks);
          changed = true;
        });
        return changed;
      })
      .run();
  };

  const applySelectedLineHeight = () => {
    if (!editor) {
      return;
    }

    const nextLineHeight = normalizeLineHeightValue(lineHeightValue);
    setLineHeightValue(nextLineHeight);
    withStablePageStageScroll(editor, () => {
      editor
        .chain()
        .focus()
        .command(({ state, tr }) => {
          let changed = false;
          const { from, to } = selectedLineHeightRange(editor);
          state.doc.nodesBetween(from, to, (node, position) => {
            if (!LINE_HEIGHT_BLOCK_TYPES.has(node.type.name)) {
              return;
            }

            tr.setNodeMarkup(position, undefined, {
              ...node.attrs,
              lineHeight: nextLineHeight,
              lineHeightLocked: true
            }, node.marks);
            changed = true;
          });
          return changed;
        })
        .run();
    });
  };

  const clearSelectedLineHeight = () => {
    if (!editor) {
      return;
    }

    withStablePageStageScroll(editor, () => {
      editor
        .chain()
        .focus()
        .command(({ state, tr }) => {
          let changed = false;
          const { from, to } = selectedLineHeightRange(editor);
          state.doc.nodesBetween(from, to, (node, position) => {
            if (!LINE_HEIGHT_BLOCK_TYPES.has(node.type.name) || (!node.attrs.lineHeight && !node.attrs.lineHeightLocked)) {
              return;
            }

            tr.setNodeMarkup(position, undefined, {
              ...node.attrs,
              lineHeight: null,
              lineHeightLocked: false
            }, node.marks);
            changed = true;
          });
          return changed;
        })
        .run();
    });
  };

  const clearAllLineHeights = () => {
    if (!editor) {
      return;
    }

    withStablePageStageScroll(editor, () => {
      editor
        .chain()
        .focus()
        .command(({ state, tr }) => {
          let changed = false;
          state.doc.descendants((node, position) => {
            if (!LINE_HEIGHT_BLOCK_TYPES.has(node.type.name) || (!node.attrs.lineHeight && !node.attrs.lineHeightLocked)) {
              return;
            }

            tr.setNodeMarkup(position, undefined, {
              ...node.attrs,
              lineHeight: null,
              lineHeightLocked: false
            }, node.marks);
            changed = true;
          });
          return changed;
        })
        .run();
    });
  };

  const pageWidth = editor ? readPageWidthPx(editor) : 420;
  const imageWidth = toolbarState.selectedImageWidth ?? Math.round(pageWidth * 0.75);
  const maxImageWidth = Math.max(240, Math.round(pageWidth));
  const textWidth = editor ? readTextWidthPx(editor) : 360;
  const textHeight = editor ? readTextHeightPx(editor) : 520;
  const qrCardWidth = toolbarState.selectedQrCardWidth ?? Math.round(textWidth * 0.75);
  const maxQrCardWidth = Math.max(180, Math.round(textWidth));
  const qrCardHeight = toolbarState.selectedQrCardHeight ?? Math.min(220, Math.round(textHeight * 0.34));
  const maxQrCardHeight = Math.max(120, Math.round(textHeight));
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
        <ToolButton label="見出し1" active={editor?.isActive("heading", { level: 1 })} disabled={disabled} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 size={18} />
        </ToolButton>
        <ToolButton label="ルビ" active={rubyPanelOpen} disabled={disabled} onClick={openRubyPanel}>
          <span className="ruby-tool-label">ルビ</span>
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
            className="image-size-number"
            type="number"
            min={48}
            max={maxImageWidth}
            value={imageWidthDraft}
            onFocus={() => {
              imageWidthInputFocusedRef.current = true;
            }}
            onChange={(event) => setImageWidthDraft(event.target.value)}
            onBlur={commitImageWidthDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitImageWidthDraft();
                event.currentTarget.blur();
              }
            }}
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
          <span className="image-size-chip">幅</span>
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
          <span className="image-size-chip">高さ</span>
          <input
            className="image-size-range"
            type="range"
            min={96}
            max={maxQrCardHeight}
            value={Math.max(96, Math.min(maxQrCardHeight, qrCardHeight))}
            onChange={(event) => setQrCardHeight(Number(event.target.value))}
            aria-label="QRカード高さ"
          />
          <input
            className="image-size-number"
            type="number"
            min={96}
            max={maxQrCardHeight}
            value={Math.round(qrCardHeight)}
            onChange={(event) => setQrCardHeight(Number(event.target.value))}
            aria-label="QRカード高さpx"
          />
          <span className="image-size-unit">px</span>
          <button type="button" onMouseDown={preserveEditorSelection} onClick={() => setQrCardHeight(null)}>
            高さ自動
          </button>
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
        <button type="button" onMouseDown={preserveEditorSelection} onClick={applySelectedTextSize}>選択部分</button>
        <button type="button" onMouseDown={preserveEditorSelection} onClick={() => applyBlockTextSize("all")}>全体</button>
        <button type="button" onMouseDown={preserveEditorSelection} onClick={() => applyBlockTextSize("headings")}>見出し全体</button>
        <button type="button" onMouseDown={preserveEditorSelection} onClick={() => applyBlockTextSize("body")}>本文のみ</button>
        <button type="button" onMouseDown={preserveEditorSelection} onClick={clearTextSizes}>サイズ解除</button>
        <span className="toolbar-divider" />
        <span className="image-size-chip">行間</span>
        <input
          className="text-size-number"
          type="number"
          min={0.8}
          max={3.5}
          step={0.01}
          value={lineHeightValue}
          onChange={(event) => setLineHeightValue(Number(event.target.value))}
          onBlur={() => setLineHeightValue((value) => normalizeLineHeightValue(value))}
          aria-label="選択範囲の行間倍率"
        />
        <button type="button" onMouseDown={preserveEditorSelection} onClick={applySelectedLineHeight}>選択ロック</button>
        <button type="button" onMouseDown={preserveEditorSelection} onClick={clearSelectedLineHeight}>行間解除</button>
        <button type="button" onMouseDown={preserveEditorSelection} onClick={clearAllLineHeights}>全行間解除</button>
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
    left.selectedQrCardWidth === right.selectedQrCardWidth &&
    left.selectedQrCardHeight === right.selectedQrCardHeight
  );
}

function normalizeLineHeightValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 1.75;
  }

  return Math.round(Math.max(0.8, Math.min(3.5, value)) * 100) / 100;
}

function selectedLineHeightRange(editor: Editor): { from: number; to: number } {
  const { selection } = editor.state;
  if (!selection.empty) {
    return { from: selection.from, to: selection.to };
  }

  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    const node = selection.$from.node(depth);
    if (LINE_HEIGHT_BLOCK_TYPES.has(node.type.name)) {
      return {
        from: selection.$from.before(depth),
        to: selection.$from.after(depth)
      };
    }
  }

  return { from: selection.from, to: selection.to };
}

function restorePageStageScroll(editor: Editor, scrollTop: number, scrollLeft: number): void {
  const stage = editor.view.dom.closest<HTMLElement>(".page-stage");
  if (!stage) {
    return;
  }

  const restore = () => {
    const maxScrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
    const nextScrollTop = Math.max(0, Math.min(scrollTop, maxScrollTop));
    if (Math.abs(stage.scrollTop - nextScrollTop) > 1) {
      stage.scrollTop = nextScrollTop;
    }
    if (Math.abs(stage.scrollLeft - scrollLeft) > 1) {
      stage.scrollLeft = scrollLeft;
    }
    stage.style.setProperty("--page-scroll-top", `${stage.scrollTop}px`);
  };

  restore();
  window.requestAnimationFrame(restore);
  window.requestAnimationFrame(() => window.requestAnimationFrame(restore));
  window.setTimeout(restore, 80);
  window.setTimeout(restore, 240);
}

function withStablePageStageScroll<T>(editor: Editor, action: () => T): T {
  const stage = editor.view.dom.closest<HTMLElement>(".page-stage");
  const scrollTop = stage?.scrollTop ?? 0;
  const scrollLeft = stage?.scrollLeft ?? 0;
  const result = action();
  if (stage) {
    restorePageStageScroll(editor, scrollTop, scrollLeft);
  }
  return result;
}

async function insertClipboardImageFiles(editor: Editor, files: File[]): Promise<void> {
  for (const file of files) {
    const src = await fileToDataUrl(file);
    withStablePageStageScroll(editor, () => {
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
    });
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

  withStablePageStageScroll(editor, () => {
    editor.chain().focus().insertContent(template.innerHTML).run();
  });
}

function readGoogleDocsLayoutHints(html: string): PasteLayoutHints | null {
  if (!/docs-internal-guid|google-docs|kix-/i.test(html)) {
    return null;
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const fontSizes: number[] = [];
  const lineHeights: number[] = [];
  const paragraphSpacings: number[] = [];
  const styledElements = Array.from(template.content.querySelectorAll<HTMLElement>("[style]"));

  for (const element of styledElements) {
    const fontSizePt = parseCssSizeToPt(element.style.fontSize);
    if (fontSizePt !== null && fontSizePt >= 4 && fontSizePt <= 72) {
      fontSizes.push(fontSizePt);
    }

    const lineHeight = parseCssLineHeight(element.style.lineHeight, fontSizePt);
    if (lineHeight !== null && lineHeight >= 0.8 && lineHeight <= 3.5) {
      lineHeights.push(lineHeight);
    }
  }

  for (const paragraph of Array.from(template.content.querySelectorAll<HTMLElement>("p,div"))) {
    const marginBottomPt = parseCssSizeToPt(paragraph.style.marginBottom);
    if (marginBottomPt !== null && marginBottomPt >= 0 && marginBottomPt <= 72) {
      paragraphSpacings.push(ptToMm(marginBottomPt));
    }
  }

  const hints: PasteLayoutHints = {};
  const fontSizePt = median(fontSizes);
  const lineHeight = median(lineHeights);
  const paragraphSpacingMm = median(paragraphSpacings);

  if (fontSizePt !== null) {
    hints.fontSizePt = roundTo(fontSizePt, 1);
  }
  if (lineHeight !== null) {
    hints.lineHeight = roundTo(lineHeight, 2);
  }
  if (paragraphSpacingMm !== null) {
    hints.paragraphSpacingMm = roundTo(paragraphSpacingMm, 1);
  }

  return Object.keys(hints).length > 0 ? hints : null;
}

function parseCssLineHeight(value: string, fontSizePt: number | null): number | null {
  if (!value || value === "normal") {
    return null;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  if (value.trim().endsWith("%")) {
    return parsed / 100;
  }

  if (/^[\d.]+$/.test(value.trim())) {
    return parsed;
  }

  const lineHeightPt = parseCssSizeToPt(value);
  return lineHeightPt !== null && fontSizePt !== null && fontSizePt > 0 ? lineHeightPt / fontSizePt : null;
}

function parseCssSizeToPt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (trimmed.endsWith("px")) {
    return parsed * 0.75;
  }
  if (trimmed.endsWith("mm")) {
    return parsed / 0.352778;
  }
  if (trimmed.endsWith("cm")) {
    return (parsed * 10) / 0.352778;
  }
  if (trimmed.endsWith("in")) {
    return parsed * 72;
  }
  if (trimmed.endsWith("pt") || /^[\d.]+$/.test(trimmed)) {
    return parsed;
  }

  return null;
}

function ptToMm(value: number): number {
  return value * 0.352778;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
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

function readTextHeightPx(editor: Editor): number {
  const guide = editor.view.dom.closest(".page-stage")?.querySelector<HTMLElement>(".page-safe-guide");
  const height = guide?.offsetHeight ?? 0;
  return Number.isFinite(height) && height > 0 ? height : readCssLengthPx(editor, "--content-height");
}

function readMaximumImageWidth(editor: Editor, image: HTMLImageElement | null): number {
  const textWidth = readTextWidthPx(editor);
  const textHeight = readTextHeightPx(editor);
  const fitPadding = readImageFitPaddingPx(editor);
  const aspectRatio = readImageAspectRatio(image);
  return Math.max(48, Math.min(textWidth, (textHeight - fitPadding * 2) * aspectRatio));
}

function readMaximumImageWidthForCurrentPage(editor: Editor, image: HTMLImageElement | null): number {
  if (!image) {
    return readMaximumImageWidth(editor, image);
  }

  const aspectRatio = readImageAspectRatio(image);
  const availableHeight = readAvailableImageHeightForCurrentPage(editor, image);
  return Math.max(48, Math.min(readTextWidthPx(editor), availableHeight * aspectRatio));
}

function readImageAspectRatio(image: HTMLImageElement | null): number {
  if (!image) {
    return 1;
  }

  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    return Math.max(0.05, image.naturalWidth / image.naturalHeight);
  }

  const rect = image.getBoundingClientRect();
  return Math.max(0.05, rect.width / Math.max(1, rect.height));
}

function readAvailableImageHeightForCurrentPage(editor: Editor, image: HTMLImageElement): number {
  const fitPadding = readImageFitPaddingPx(editor);
  const fallbackHeight = Math.max(64, readTextHeightPx(editor) - fitPadding * 2);
  const block = image.closest<HTMLElement>("[data-resize-container][data-node='image']") ?? image.closest<HTMLElement>("[data-resize-wrapper]") ?? image;
  const blockRect = block.getBoundingClientRect();
  const safeGuide = pageSafeGuideForRect(editor, blockRect);
  if (!safeGuide) {
    return fallbackHeight;
  }

  const safeRect = safeGuide.getBoundingClientRect();
  const contentAfterBottom = readFollowingContentBottomInPage(editor, block, blockRect, safeRect);
  if (contentAfterBottom !== null) {
    const currentBlockHeight = Math.max(1, blockRect.height);
    return Math.max(64, currentBlockHeight + safeRect.bottom - contentAfterBottom - fitPadding);
  }

  return Math.max(64, safeRect.bottom - blockRect.top - fitPadding);
}

function readImageFitPaddingPx(editor: Editor): number {
  const rawValue = getComputedStyle(editor.view.dom).getPropertyValue("--image-fit-padding").trim();
  if (rawValue === "0" || rawValue === "0px" || rawValue === "0mm") {
    return 0;
  }

  const value = readCssLengthPx(editor, "--image-fit-padding");
  return Number.isFinite(value) && value >= 0 ? value : IMAGE_FIT_PADDING_PX;
}

function pageSafeGuideForRect(editor: Editor, targetRect: DOMRect): HTMLElement | null {
  const guides = Array.from(editor.view.dom.closest(".page-stage")?.querySelectorAll<HTMLElement>(".page-safe-guide") ?? []);
  if (guides.length === 0) {
    return null;
  }

  const targetCenterX = targetRect.left + targetRect.width / 2;
  return guides.reduce<{ guide: HTMLElement | null; distance: number }>(
    (best, guide) => {
      const rect = guide.getBoundingClientRect();
      const overlaps = targetCenterX >= rect.left - 2 && targetCenterX <= rect.right + 2;
      const distance = overlaps ? 0 : Math.min(Math.abs(targetCenterX - rect.left), Math.abs(targetCenterX - rect.right));
      return distance < best.distance ? { guide, distance } : best;
    },
    { guide: null, distance: Number.POSITIVE_INFINITY }
  ).guide;
}

function readFollowingContentBottomInPage(editor: Editor, block: HTMLElement, blockRect: DOMRect, safeRect: DOMRect): number | null {
  const candidates = Array.from(
    editor.view.dom.querySelectorAll<HTMLElement>(
      "p,h1,h2,h3,blockquote,ul,ol,figure[data-type='qr-card'],section[data-type='table-of-contents'],[data-resize-container][data-node='image']"
    )
  );
  let bottom: number | null = null;

  for (const candidate of candidates) {
    if (candidate === block || block.contains(candidate) || candidate.contains(block)) {
      continue;
    }

    const rect = candidate.getBoundingClientRect();
    const inSamePage =
      rect.right > safeRect.left + 2 &&
      rect.left < safeRect.right - 2 &&
      rect.bottom > safeRect.top &&
      rect.top < safeRect.bottom + 2;
    if (!inSamePage || rect.top < blockRect.bottom - 1) {
      continue;
    }

    bottom = Math.max(bottom ?? rect.bottom, rect.bottom);
  }

  return bottom;
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

function renderedImages(editor: Editor): HTMLImageElement[] {
  return Array.from(editor.view.dom.querySelectorAll<HTMLImageElement>("img:not(.qr-card-image)"));
}

function renderedImageAtPosition(editor: Editor, position: number): HTMLImageElement | null {
  const nodeDom = editor.view.nodeDOM(position);
  if (nodeDom instanceof HTMLImageElement && !nodeDom.classList.contains("qr-card-image")) {
    return nodeDom;
  }
  if (nodeDom instanceof HTMLElement) {
    return nodeDom.matches("img:not(.qr-card-image)")
      ? (nodeDom as HTMLImageElement)
      : nodeDom.querySelector<HTMLImageElement>("img:not(.qr-card-image)");
  }
  return null;
}

function selectedRenderedImage(editor: Editor): HTMLImageElement | null {
  const target = readSelectedImageTarget(editor);
  const images = renderedImages(editor);
  if (!target) {
    return images.find((image) => image.closest(".ProseMirror-selectednode")) ?? null;
  }

  return (
    (target.position !== null ? renderedImageAtPosition(editor, target.position) : null) ??
    images.find((image) => image.getAttribute("src") === target.src && image.getAttribute("title") === target.title) ??
    images.find((image) => image.getAttribute("src") === target.src) ??
    images.find((image) => image.closest(".ProseMirror-selectednode")) ??
    null
  );
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

function syncRenderedImageWidth(editor: Editor, target: ImageReplacementTarget | null, width: number): void {
  const image = target ? selectedRenderedImageByTarget(editor, target) : selectedRenderedImage(editor);
  if (!image) {
    return;
  }

  const nextWidth = `${Math.round(width)}px`;
  image.style.width = nextWidth;
  image.style.height = "auto";
  image.setAttribute("width", String(Math.round(width)));
  image.removeAttribute("height");

  const wrapper = image.closest<HTMLElement>("[data-resize-wrapper]");
  if (wrapper) {
    wrapper.style.width = nextWidth;
    wrapper.style.maxWidth = nextWidth;
  }
}

function selectedRenderedImageByTarget(editor: Editor, target: ImageReplacementTarget): HTMLImageElement | null {
  const images = renderedImages(editor);
  return (
    (target.position !== null ? renderedImageAtPosition(editor, target.position) : null) ??
    images.find((candidate) => candidate.getAttribute("src") === target.src && candidate.getAttribute("title") === target.title) ??
    images.find((candidate) => candidate.getAttribute("src") === target.src) ??
    images.find((candidate) => candidate.closest(".ProseMirror-selectednode")) ??
    null
  );
}

function readRenderedImageWidth(image: HTMLImageElement): number | null {
  const wrapper = image.closest<HTMLElement>("[data-resize-wrapper]");
  const measuredWidth = wrapper ? Math.round(wrapper.getBoundingClientRect().width) : Math.round(image.getBoundingClientRect().width);
  const width =
    parseImageDimension(wrapper?.style.width) ??
    parseImageDimension(wrapper?.getAttribute("width")) ??
    parseImageDimension(image.style.width) ??
    parseImageDimension(image.getAttribute("width")) ??
    parseImageDimension(image.getAttribute("data-width")) ??
    measuredWidth;
  return Number.isFinite(width) && width > 0 ? width : null;
}

function previousImageWidth(editor: Editor, selectedPosition: number): number | null {
  let previousWidth: number | null = null;
  editor.state.doc.descendants((node, position) => {
    if (position >= selectedPosition || node.type.name !== "image") {
      return;
    }

    const renderedImage = renderedImageAtPosition(editor, position);
    previousWidth = parseImageDimension(node.attrs.width) ?? (renderedImage ? readRenderedImageWidth(renderedImage) : null);
  });

  return previousWidth;
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
