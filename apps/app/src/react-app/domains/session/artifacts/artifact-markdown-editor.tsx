import { useEffect, useMemo, useRef } from "react";
import {
  MDXEditor, type MDXEditorMethods, UndoRedo, BoldItalicUnderlineToggles,
  BlockTypeSelect, ListsToggle, CreateLink, InsertImage, InsertTable,
  InsertCodeBlock, InsertThematicBreak, Separator, DiffSourceToggleWrapper,
  headingsPlugin, listsPlugin, quotePlugin, linkPlugin, linkDialogPlugin,
  imagePlugin, tablePlugin, thematicBreakPlugin, frontmatterPlugin,
  codeBlockPlugin, codeMirrorPlugin, diffSourcePlugin, toolbarPlugin, markdownShortcutPlugin,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import "./markdown-editor.css";
import { t } from "@/i18n";

type Props = {
  value: string;
  baseline: string;
  onChange: (value: string) => void;
  imageUpload: (file: File) => Promise<string>;
  imagePreview: (source: string) => Promise<string>;
};

export function ArtifactMarkdownEditor({ value, baseline, onChange, imageUpload, imagePreview }: Props) {
  const editor = useRef<MDXEditorMethods>(null);
  const initial = useRef(value);
  const lastValue = useRef(value);
  const plugins = useMemo(() => [
    headingsPlugin(), listsPlugin(), quotePlugin(), linkPlugin(), linkDialogPlugin(),
    imagePlugin({ imageUploadHandler: imageUpload, imagePreviewHandler: imagePreview }),
    tablePlugin(), thematicBreakPlugin(), frontmatterPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: "txt" }),
    codeMirrorPlugin({ codeBlockLanguages: { txt: "Text", js: "JavaScript", ts: "TypeScript", json: "JSON", python: "Python", sql: "SQL", bash: "Shell", mermaid: "Mermaid" } }),
    diffSourcePlugin({ viewMode: "rich-text", diffMarkdown: baseline }),
    markdownShortcutPlugin(),
    toolbarPlugin({ toolbarContents: () => (
      <DiffSourceToggleWrapper>
        <UndoRedo /><Separator /><BlockTypeSelect /><Separator />
        <BoldItalicUnderlineToggles options={["Bold", "Italic"]} /><ListsToggle />
        <Separator /><CreateLink /><InsertImage /><InsertTable /><InsertCodeBlock /><InsertThematicBreak />
      </DiffSourceToggleWrapper>
    ) }),
  ], [baseline, imageUpload, imagePreview]);

  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    editor.current?.setMarkdown(value);
  }, [value]);

  return <MDXEditor
    ref={editor}
    className="lw-markdown-editor"
    contentEditableClassName="lw-markdown-page"
    markdown={initial.current}
    trim={false}
    plugins={plugins}
    placeholder={t("artifact.start_writing")}
    onChange={(markdown, initialNormalize) => {
      // Opening a file must not rewrite its original whitespace or bullet style.
      if (initialNormalize) return;
      lastValue.current = markdown;
      onChange(markdown);
    }}
  />;
}
