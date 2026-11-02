import { viewMarkdownPlugin } from "../../views/view-markdown-plugin";
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";
import { createPortal } from "react-dom";
import {
  MDXEditor, type MDXEditorMethods,
  headingsPlugin, listsPlugin, quotePlugin, linkPlugin, linkDialogPlugin,
  imagePlugin, tablePlugin, thematicBreakPlugin, frontmatterPlugin,
  codeBlockPlugin, codeMirrorPlugin, diffSourcePlugin, toolbarPlugin, markdownShortcutPlugin,
  realmPlugin, addSyntaxExtension$, viewMode$, readOnly$, activeEditor$, openLinkEditDialog$, markdownProcessingError$, markdown$, muteChange$, createRootEditorSubscription$, useCellValue, usePublisher, type RealmPlugin, type ViewMode,
} from "@mdxeditor/editor";
import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { Code, FileText, GitCompareArrows, Ellipsis, Link } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MarkdownImageDialog } from "./markdown-image-dialog";
import "./markdown-editor-vendor.css";
import "./markdown-editor.css";
import { markdownCodeTheme } from "./markdown-code-theme";
import { t } from "@/i18n";
import { markdownBlocksPlugin } from "./markdown-block-controls";
import { preservedFrontmatterPlugin } from "./markdown-frontmatter-plugin";
import { documentFingerprint, literalHtmlSyntax, requiresMarkdownSource } from "./markdown-document-sync";
import { preserveMarkdownFrontmatter } from "./markdown-block-model";
import { $getNearestNodeFromDOMNode } from "lexical";

// Lexical renders app-specific schemes as about:blank. Read the original link
// from its document state and route clicks through the host, without weakening
// the editor's URL sanitizer or rewriting the saved Markdown.
const appLinkNavigationPlugin = realmPlugin<{ getOpen: () => ((href: string) => void) | undefined }>({
  init(realm, params) {
    realm.pub(createRootEditorSubscription$, editor => {
      const click = (event: MouseEvent) => {
        const open = params?.getOpen();
        if (!open || !(event.target instanceof Node)) return;
        const target = event.target;
        const href = editor.getEditorState().read(() => {
          let node = $getNearestNodeFromDOMNode(target);
          while (node && node.getType() !== "link" && node.getType() !== "autolink") node = node.getParent();
          const data = node?.exportJSON();
          return data && "url" in data && typeof data.url === "string" ? data.url : null;
        }, { editor });
        if (!href || href.startsWith("#") || (editor.isEditable() && !event.metaKey && !event.ctrlKey && !/^legalwork(?:task|-view|-wiki):/i.test(href))) return;
        event.preventDefault();
        event.stopPropagation();
        open(href);
      };
      return editor.registerRootListener((root, previous) => {
        previous?.removeEventListener("click", click, true);
        root?.addEventListener("click", click, true);
      });
    });
  },
});

type Props = {
  value: string;
  baseline: string;
  readOnly?: boolean;
  onChange: (value: string) => void;
  imageUpload: (file: File) => Promise<string>;
  imagePreview: (source: string) => Promise<string>;
  extensions?: RealmPlugin[];
  viewModeRequest?: { mode: ViewMode };
  linkSuggestions?: string[];
  LinkDialog?: () => ReactElement;
  /** Place page options beside an external title instead of above the editor body. */
  toolbarTarget?: HTMLElement | null;
  toolbarMenuItems?: ReactNode;
  onOpenLink?: (url: string) => void;
  suppressHtmlProcessing?: boolean;
  allowDiff?: boolean;
  /** Render typed properties outside the editor while keeping full-file Source editing. */
  externalFrontmatter?: boolean;
  /** Reattach page content managed outside the rich-text body. Source stays complete. */
  serializeRichText?: (previous: string, body: string) => string;
};

function MarkdownToolbar({ rawMarkdown, showLink = true, allowDiff, literalHtml, menuItems }: { rawMarkdown: () => string; showLink?: boolean; allowDiff: boolean; literalHtml: boolean; menuItems?: ReactNode }) {
  const mode = useCellValue(viewMode$);
  const readOnly = useCellValue(readOnly$);
  const editLink = usePublisher(openLinkEditDialog$);
  const activeEditor = useCellValue(activeEditor$);
  const sourceRequired = requiresMarkdownSource(rawMarkdown(), literalHtml);
  const changeMode = usePublisher(viewMode$);
  const changeSource = usePublisher(markdown$);
  const selectMode = (next: ViewMode) => {
    const raw = rawMarkdown();
    changeMode(next);
    if (next !== "rich-text") changeSource(raw);
  };
  return <div className="lw-markdown-tools">
    {showLink && mode === "rich-text" && !readOnly && <Button size="icon-sm" variant="ghost" aria-label={t("markdown.toolbar.link")} title={t("markdown.toolbar.link")} onMouseDown={event => event.preventDefault()} onClick={() => activeEditor?.focus(() => editLink(), { defaultSelection: "rootEnd" })}><Link /></Button>}
    {mode !== "rich-text" && sourceRequired && <span className="lw-source-note" role="status">{t("markdown.blocks.source_required")}</span>}
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={t("markdown.page.options")} />}><Ellipsis /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={sourceRequired} onClick={() => selectMode("rich-text")}><FileText />{t("markdown.toolbar.richText")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => selectMode("source")}><Code />{t("markdown.toolbar.source")}</DropdownMenuItem>
        {allowDiff && <DropdownMenuItem onClick={() => selectMode("diff")}><GitCompareArrows />{t("markdown.toolbar.diffMode")}</DropdownMenuItem>}
        {menuItems}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

export function ArtifactMarkdownEditor({ value, baseline, readOnly = false, onChange, imageUpload, imagePreview, extensions, viewModeRequest, linkSuggestions, LinkDialog, toolbarTarget, toolbarMenuItems, onOpenLink, suppressHtmlProcessing = false, allowDiff = true, externalFrontmatter = false, serializeRichText }: Props) {
  const theme = useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, getResolvedThemeMode);
  const openLink = useRef(onOpenLink);
  openLink.current = onOpenLink;
  const editor = useRef<MDXEditorMethods>(null);
  const initial = useRef(value);
  const initialMode = useRef<ViewMode>(viewModeRequest?.mode === "diff" ? "diff" : requiresMarkdownSource(value, suppressHtmlProcessing) ? "source" : viewModeRequest?.mode ?? "rich-text");
  const lastValue = useRef(value);
  const syncSource = useRef<((value: string, previous: string) => void) | null>(null);
  const lastViewRequest = useRef(viewModeRequest);
  const mode = useRef<ViewMode>(initialMode.current);
  const currentProps = useRef({ onChange, externalFrontmatter, serializeRichText });
  currentProps.current = { onChange, externalFrontmatter, serializeRichText };
  const publish = (next: string) => {
    if (next === lastValue.current) return;
    lastValue.current = next;
    currentProps.current.onChange(next);
  };
  const sourceExtensions = useMemo(() => [...markdownCodeTheme, EditorView.updateListener.of(update => {
    // The upstream SourceEditor reports focus/selection transactions as changes.
    // Only an actual source document edit may replace the canonical raw file.
    if (update.docChanged && !update.state.readOnly && mode.current !== "rich-text" && update.transactions.some(transaction => transaction.annotation(Transaction.userEvent))) publish(update.state.doc.toString());
  })], []);
  const requestedViewPlugin = useMemo(() => realmPlugin<{ mode: ViewMode }>({
    init(realm) {
      if (suppressHtmlProcessing) realm.pub(addSyntaxExtension$, literalHtmlSyntax);
      syncSource.current = (value, previous) => {
        if (mode.current === "rich-text" && requiresMarkdownSource(value, suppressHtmlProcessing)) realm.pub(viewMode$, "source");
        if (mode.current !== "rich-text") {
          // Source edits update the visible CodeMirror document independently of
          // markdown$. Advance that cell through the previous raw value so an
          // external edit still refreshes Diff after a user reverts a change.
          realm.pub(markdown$, previous);
          realm.pub(markdown$, value);
        }
      };
      let fingerprint: string | null = null;
      realm.pub(createRootEditorSubscription$, root => root.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
        if (!dirtyElements.size && !dirtyLeaves.size) return;
        const nextFingerprint = documentFingerprint(editorState.toJSON());
        const changed = fingerprint !== null && fingerprint !== nextFingerprint;
        fingerprint = nextFingerprint;
        if (changed && !realm.getValue(muteChange$) && !realm.getValue(markdownProcessingError$)) {
          const markdown = realm.getValue(markdown$);
          const preserved = currentProps.current.externalFrontmatter ? preserveMarkdownFrontmatter(lastValue.current, markdown) : markdown;
          publish(currentProps.current.serializeRichText?.(lastValue.current, preserved) ?? preserved);
        }
        // SourceEditor initializes from markdown$, not markdownSourceEditorValue$.
        // Nested table editors can serialize on blur, after a view switch. Restore
        // the exact source after that flush even when there was no document edit.
        if (mode.current !== "rich-text") realm.pub(markdown$, lastValue.current);
      }));
      realm.sub(viewMode$, value => {
        mode.current = value;
        if (value === "rich-text" && requiresMarkdownSource(lastValue.current, suppressHtmlProcessing)) { realm.pub(viewMode$, "source"); return; }
        if (value !== "rich-text") realm.pub(markdown$, lastValue.current);
      });
      realm.sub(markdownProcessingError$, error => {
        if (!error) return;
        if (mode.current !== "diff") realm.pub(viewMode$, "source");
        realm.pub(markdown$, lastValue.current);
      });
    },
    update(realm, request) {
      if (request === lastViewRequest.current) return;
      lastViewRequest.current = request;
      if (request) realm.pub(viewMode$, request.mode);
    },
  }), [suppressHtmlProcessing]);
  const plugins = useMemo(() => [
    headingsPlugin(), listsPlugin(), quotePlugin(), linkPlugin(), linkDialogPlugin({ LinkDialog, linkAutocompleteSuggestions: linkSuggestions, onClickLinkCallback: onOpenLink }), appLinkNavigationPlugin({ getOpen: () => openLink.current }),
    imagePlugin({ imageUploadHandler: imageUpload, imagePreviewHandler: imagePreview, ImageDialog: MarkdownImageDialog }),
    tablePlugin(), thematicBreakPlugin(), externalFrontmatter ? preservedFrontmatterPlugin() : frontmatterPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: "txt" }),
    viewMarkdownPlugin(),
    codeMirrorPlugin({ codeMirrorExtensions: markdownCodeTheme, codeBlockLanguages: { txt: "Text", js: "JavaScript", ts: "TypeScript", json: "JSON", python: "Python", sql: "SQL", bash: "Shell", mermaid: "Mermaid" } }),
    diffSourcePlugin({ codeMirrorExtensions: sourceExtensions, viewMode: initialMode.current, diffMarkdown: baseline }),
    requestedViewPlugin(viewModeRequest),
    ...(extensions ?? []),
    markdownShortcutPlugin(),
    markdownBlocksPlugin(),
    toolbarPlugin({ toolbarContents: () => toolbarTarget === undefined
      ? <MarkdownToolbar rawMarkdown={() => lastValue.current} allowDiff={allowDiff} literalHtml={suppressHtmlProcessing} menuItems={toolbarMenuItems} />
      : toolbarTarget ? createPortal(<MarkdownToolbar rawMarkdown={() => lastValue.current} showLink={false} allowDiff={allowDiff} literalHtml={suppressHtmlProcessing} menuItems={toolbarMenuItems} />, toolbarTarget) : null }),
  ], [baseline, sourceExtensions, imageUpload, imagePreview, extensions, requestedViewPlugin, viewModeRequest, linkSuggestions, LinkDialog, toolbarTarget, toolbarMenuItems, onOpenLink, externalFrontmatter, readOnly, allowDiff, suppressHtmlProcessing]);

  useEffect(() => {
    if (value === lastValue.current) return;
    const previous = lastValue.current;
    lastValue.current = value;
    editor.current?.setMarkdown(value);
    syncSource.current?.(value, previous);
  }, [value]);

  return <MDXEditor
    ref={editor}
    translation={(key, defaultValue, interpolations) => {
      const translationKey = `markdown.${key}`;
      const translated = t(translationKey, Object.fromEntries(Object.entries(interpolations ?? {}).map(([name, value]) => [name, String(value)])));
      return translated === translationKey ? defaultValue : translated;
    }}
    className={`lw-markdown-editor${toolbarTarget === undefined ? "" : " lw-markdown-external-toolbar"}${theme === "dark" ? " dark-theme" : ""}`}
    contentEditableClassName="lw-markdown-page"
    markdown={initial.current}
    trim={false}
    readOnly={readOnly}
    suppressHtmlProcessing={suppressHtmlProcessing}
    plugins={plugins}
    placeholder={t("artifact.start_writing")}
  />;
}
