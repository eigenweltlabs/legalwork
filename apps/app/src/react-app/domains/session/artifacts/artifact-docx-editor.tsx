import { docxTemplateSchema, documentNavigationTargetSchema, type DocumentNavigationTarget } from "@legalwork/types/office-editor";
import { executeWordBatch } from "./docx-agent-batch";
import { readWordDocument } from "./docx-agent-read";
import { useDocumentVisibility } from "./document-runtime";
import { acceptTemplateRevisions, templateRevisionIds } from "./docx-template-revisions";
import { normalizeDocxLineBreaks } from "./docx-line-breaks";
import { isDocumentReadTool } from "./document-agent-read";
/** @jsxImportSource react */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { DocxEditor, type DocxEditorRef, type EditorMode } from "@eigenpal/docx-editor-react";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { useDocxAgentTools } from "@eigenpal/docx-editor-agents/react";
import { headerFooterToProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { createSuggestionModePlugin, setSuggestionMode, suggestionModeKey } from "@eigenpal/docx-editor-core/prosemirror/plugins";
import { setGoogleFontsEnabled } from "@eigenpal/docx-editor-core";
import { acceptChangeById, rejectChangeById } from "@eigenpal/docx-editor-core/prosemirror/commands";
import { extractTrackedChanges } from "@eigenpal/docx-editor-core/prosemirror/utils/extractTrackedChanges";
import "@eigenpal/docx-editor-react/styles.css";
import "./office-fonts.css";

import { getResolvedThemeMode, subscribeToTheme, type ResolvedThemeMode } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { loadFontsFromGoogle, rememberFontDecision, unresolvedDocumentFonts } from "./docx-font-consent";
import { drainDocxRecovery, draftDecisionPendingApi, keepDocxVersion, readDocxRecovery, removeDocxRecovery, writeDocxRecovery, type DocxRecovery } from "./docx-recovery";
import { useDocxPageFit } from "./use-docx-page-fit";
import { useDocxReviewCard } from "./use-docx-review-card";
import "./docx-editor-layout.css";
import "./docx-editor-theme.css";
import { useControlActions } from "../../../shell/control/control-provider";
import { t } from "@/i18n";
import { createDocumentAutosave } from "./document-autosave";
import { createDocumentExport } from "./document-export";
import { checkDocumentTask, type DocumentTaskOptions } from "./document-task-queue";
import { createWordProtectionPlugin } from "./docx-protection";
import { decorateWordFields, navigateWordNote, updateWordFields } from "./docx-fields";
import { wordBookmarks } from "./docx-bookmarks";
import { emptyWordMetadata, finalizeWordPackage, inspectWordPackage, readWordMetadata, removeWordPrivateData, type InspectionKind, type Protection } from "./docx-word-package";
import { executeWordStructureTool, readWordStructure, WORD_STRUCTURE_MUTATIONS } from "./docx-agent-structure";
import { applyWordFormatting, preserveWordFormatting, readWordFormatting } from "./docx-agent-formatting";
import { compareWordDocuments, combineWordDocuments } from "./docx-comparison";
import { DocxWordTools } from "./docx-word-tools";
import { createCleanDocx, downloadDocx } from "./docx-export";

// The editor otherwise injects a fonts.googleapis.com stylesheet for any font a
// document names that isn't installed locally — which would tell Google the
// typefaces used in a client's file. office-fonts.css bundles the substitutes
// it used to fetch, so nothing is disclosed and nothing changes about how a
// document renders. Calibri, Cambria, Arial, Helvetica, Times New Roman and
// Courier New keep Word's pagination, being metric compatible; the other
// families are look-alikes and can re-wrap. Page-global, so it is set once at
// import, before any document.
setGoogleFontsEnabled(false);

export type DocxEditorApi = {
  navigate: (target: DocumentNavigationTarget) => Promise<unknown>;
  isReady: () => boolean;
  /** Serialize and persist the current document. Never clears edits made during a save. */
  save: () => Promise<boolean>;
  flushSave: () => Promise<boolean>;
  drain: () => Promise<void>;
  /** Serialize the live draft without writing to the workspace or clearing its dirty state. */
  getBuffer: () => Promise<ArrayBuffer | null>;
  executeAgentTool: (toolName: string, args: Record<string, unknown>, options?: DocumentTaskOptions) => Promise<DocxEditorToolResult>;
  discardRecovery: () => Promise<void>;
  revision: () => number;
  isDirty: () => boolean;
};

export type DocxEditorToolResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  saved?: boolean;
};

type ArtifactDocxEditorProps = {
  name: string;
  /** Captured on mount. The panel controls when a different disk revision is loaded. */
  content: ArrayBuffer;
  author?: string;
  readOnly?: boolean;
  interactionLocked?: boolean;
  legacyRecoveryKey?: string;
  onSave?: (buffer: ArrayBuffer) => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  apiRef?: RefObject<DocxEditorApi | null>;
  recoveryKey?: string;
  baseUpdatedAt?: number | null;
  onRestore?: (baseUpdatedAt: number | null) => void;
  autosave?: boolean;
  onAutosaveError?: (error: string | null) => void;
};

const AUTHOR_KEY = "legalwork.docx.reviewer";
let documentInstance = 0;
// Eigenpal's File > Save exports a download, even when onSave is supplied.
// Name that action accurately; the panel Save button / Cmd+S persist to the workspace.
// Read lazily: a module-scope t() would freeze the English label at import,
// before initLocale() picks the language.
const EDITOR_LABELS = {
  toolbar: {
    get save() {
      return t("artifact.download_copy");
    },
    saveShortcut: "",
  },
};

const REVIEW_TOOL_NAMES = new Set(["accept_changes", "reject_changes"]);
const SDK_MUTATIONS = new Set(["suggest_change", "add_comment", "reply_comment", "resolve_comment", "apply_formatting", "set_paragraph_style", "insert_break"]);
const COPY_TOOLS = new Set(["create_clean_copy", "create_comparison_copy"]);

function encodeWordCopy(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

/** Native document/comment updates must reach the React editor ref before a
 * save reads it, otherwise a delayed callback leaves an already-saved edit dirty. */
function flushEditorUpdate<T>(update: () => T): T {
  let result!: T;
  flushSync(() => { result = update(); });
  return result;
}

function requestedChangeIds(args: Record<string, unknown>): number[] | null {
  if (!Array.isArray(args.changeIds)) return null;
  const ids = args.changeIds.filter(
    (value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0,
  );
  return ids.length === args.changeIds.length && ids.length > 0 ? [...new Set(ids)] : null;
}

function decideTrackedChanges(
  editor: DocxEditorRef | null,
  decision: "accept" | "reject",
  requestedIds: number[],
): DocxEditorToolResult {
  const view = editor?.getEditorRef()?.getView();
  if (!view) return { success: false, error: t("docx.editor_not_ready") };

  const { entries } = extractTrackedChanges(view.state);
  const ids = new Set<number>();
  for (const requestedId of requestedIds) {
    const entry = entries.find((candidate) => (
      Number(candidate.revisionId) === requestedId
      || Number(candidate.insertionRevisionId) === requestedId
      || candidate.coalescedRevisionIds?.some((id) => Number(id) === requestedId)
    ));
    if (!entry) {
      ids.add(requestedId);
      continue;
    }
    ids.add(Number(entry.revisionId));
    if (entry.insertionRevisionId !== undefined) ids.add(Number(entry.insertionRevisionId));
    entry.coalescedRevisionIds?.forEach((id) => ids.add(Number(id)));
  }

  const command = decision === "accept" ? acceptChangeById : rejectChangeById;
  let applied = 0;
  for (const id of ids) {
    if (command(id)(view.state, view.dispatch)) applied += 1;
  }
  if (applied === 0) {
    return { success: false, error: t("docx.unknown_change_ids") };
  }
  const verb = decision === "accept" ? "Accepted" : "Rejected";
  return { success: true, data: `${verb} ${applied} tracked-change revision${applied === 1 ? "" : "s"}.` };
}

function useThemeColorMode(): ResolvedThemeMode {
  return useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, getResolvedThemeMode);
}

export function ArtifactDocxEditor(props: ArtifactDocxEditorProps) {
  const [recovery, setRecovery] = useState<DocxRecovery | null>(null);
  const [checked, setChecked] = useState(Boolean(!props.recoveryKey || props.readOnly));
  const [restored, setRestored] = useState<DocxRecovery | null>(null);
  useEffect(() => {
    if (!props.recoveryKey || props.readOnly) { setChecked(true); return; }
    let active = true;
    const key = props.recoveryKey;
    void readDocxRecovery(key, props.legacyRecoveryKey).then((draft) => {
      if (active) { setRecovery(draft); setChecked(true); }
    }).catch(() => {
      if (active) { setChecked(true); toast.error(t("docx.recovery_unavailable")); }
    });
    return () => { active = false; };
  }, [props.recoveryKey, props.legacyRecoveryKey, props.readOnly]);
  const { apiRef, name } = props;
  useEffect(() => {
    if (!recovery || !apiRef) return;
    const pending = draftDecisionPendingApi(name);
    apiRef.current = pending;
    return () => { if (apiRef.current === pending) apiRef.current = null; };
  }, [recovery, apiRef, name]);
  if (!checked) return <div className="p-6 text-sm" role="status">{t("docx.checking_draft")}</div>;
  if (recovery) return <div className="space-y-4 p-6">
    <h3 className="font-medium">{t("docx.recover_prompt")}</h3>
    <p className="text-sm text-muted-foreground">{t("docx.recover_saved_draft", { name: props.name, time: new Date(recovery.savedAt).toLocaleString() })}</p>
    {recovery.baseUpdatedAt !== props.baseUpdatedAt && <p className="text-sm">{t("docx.recover_body")}</p>}
    <div className="flex gap-2">
      <Button onClick={() => { props.onRestore?.(recovery.baseUpdatedAt); setRestored(recovery); setRecovery(null); }}>{t("docx.recover_draft")}</Button>
      <Button variant="outline" onClick={() => {
        void removeDocxRecovery(recovery.key).then(() => setRecovery(null)).catch(() => toast.error(t("docx.discard_recovery_failed")));
      }}>{t("docx.discard_and_open")}</Button>
    </div>
  </div>;
  return <LiveDocxEditor {...props} content={restored?.buffer ?? props.content} recovered={!!restored} />;
}

function LiveDocxEditor({ name, content, author, readOnly = false, interactionLocked = false, onSave, onDirtyChange, apiRef, recoveryKey, baseUpdatedAt = null, recovered, autosave = false, onAutosaveError }: ArtifactDocxEditorProps & { recovered: boolean }) {
  const visible = useDocumentVisibility();
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const colorMode = useThemeColorMode();
  const [documentBuffer] = useState(() => content.slice(0));
  const [documentId] = useState(() => `${Date.now()}:${++documentInstance}`);
  const [mode, setMode] = useState<EditorMode>("editing");
  const [wordMetadata, setWordMetadata] = useState(emptyWordMetadata);
  const metadataRef = useRef(wordMetadata);
  const [metadataReady, setMetadataReady] = useState(false);
  const [metadataError, setMetadataError] = useState("");
  useEffect(() => {
    let active = true;
    void readWordMetadata(documentBuffer).then((metadata) => {
      if (!active) return;
      metadataRef.current = metadata;
      setWordMetadata(metadata);
      if (metadata.protection.mode === "trackedChanges") setMode("suggesting");
      setMetadataReady(true);
    }).catch((error) => { if (active) setMetadataError(String(error)); });
    return () => { active = false; };
  }, [documentBuffer]);
  const [protectionPlugin] = useState(() => createWordProtectionPlugin(() => metadataRef.current.protection, () => toast.error(t("docx.word.edit_blocked"))));
  const [wordPlugins] = useState(() => [protectionPlugin]);
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(recovered);
  const checkpoint = useRef<() => Promise<void>>(async () => {});
  const checkpointWork = useRef<Promise<void>>(Promise.resolve());
  const checkpointed = useRef<{ revision: number; base: number | null } | null>(null);
  const [reviewer] = useState(() => {
    if (author) return author;
    try { return window.localStorage.getItem(AUTHOR_KEY) ?? ""; } catch { return ""; }
  });
  const editorRef = useRef<DocxEditorRef>(null);
  useLayoutEffect(() => {
    const view = editorRef.current?.getEditorRef()?.getView();
    // The native paginated editor portals its input directly into document.body,
    // outside our offscreen host. It must inherit the document's visibility too.
    if (view) {
      view.dom.inert = !visible;
      if (visible) view.dom.removeAttribute("aria-hidden");
      else view.dom.setAttribute("aria-hidden", "true");
    }
  }, [visible]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [changeCount, setChangeCount] = useState(0);
  const [reviewDecision, setReviewDecision] = useState<{ decision: "accept" | "reject"; ids: number[]; revision: number } | null>(null);
  const [missingFonts, setMissingFonts] = useState<string[]>([]);
  const fitPage = useDocxPageFit(containerRef, editorRef, commentsOpen);
  const onReviewClick = useDocxReviewCard(containerRef, editorRef);
  const recoveryFailed = useRef(false);
  const { executeToolCall } = useDocxAgentTools({ editorRef, author: "LegalWork AI" });
  const revision = useRef(0);
  const ready = useRef(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const historyStarted = useRef(false);
  const lastDocument = useRef<ReturnType<DocxEditorRef["getDocument"]>>(null);
  const lastPaintedLayout = useRef<ReturnType<NonNullable<ReturnType<DocxEditorRef["getEditorRef"]>>["getLayout"]>>(null);
  const latestSave = useRef<() => Promise<boolean>>(async () => false);
  const latestAutosaveError = useRef(onAutosaveError);
  latestAutosaveError.current = onAutosaveError;
  const [automaticSave] = useState(() => createDocumentAutosave({
    save: () => latestSave.current(),
    isDirty: () => dirty.current && ready.current,
    onError: (error) => latestAutosaveError.current?.(error instanceof Error ? error.message : t("artifact.save_failed")),
  }));

  const markDirty = useCallback(() => {
    if (readOnly || !ready.current) return;
    const view = editorRef.current?.getEditorRef()?.getView();
    if (view) setChangeCount(extractTrackedChanges(view.state).entries.length);
    revision.current += 1;
    dirty.current = true;
    onDirtyChange?.(true);
    automaticSave.changed();
    if (recoveryKey) {
      if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
      checkpointTimer.current = setTimeout(() => { void checkpoint.current(); }, 1000);
    }
  }, [readOnly, onDirtyChange, recoveryKey, automaticSave]);

  // Ask before fetching a font the document needs and this machine lacks — the
  // one case office-fonts.css cannot cover locally. Runs once the editor has
  // rendered, so canRenderFont() sees the faces the document embedded.
  const askAboutFonts = useCallback(() => {
    void unresolvedDocumentFonts(documentBuffer)
      .then((families) => { if (families.length > 0) setMissingFonts(families); })
      .catch(() => {});
  }, [documentBuffer]);

  const fontsUnavailable = useCallback((families: string[]) => {
    // Say so rather than leaving a pressed button looking like it did nothing.
    // Remember the answer too, so the same dead end is not offered again — but
    // not when this machine was simply offline, where a later open can still
    // succeed.
    if (navigator.onLine !== false) rememberFontDecision(families, false);
    toast.error(t("docx.font_download_failed", { count: families.length, fonts: families.join(", ") }));
  }, []);

  const resolveFonts = useCallback((allowed: boolean) => {
    const families = missingFonts;
    setMissingFonts([]);
    if (!allowed) {
      rememberFontDecision(families, false);
      return;
    }
    void loadFontsFromGoogle(families)
      .then((failed) => {
        fitPage();
        rememberFontDecision(families.filter((family) => !failed.includes(family)), true);
        if (failed.length > 0) fontsUnavailable(failed);
      })
      .catch(() => fontsUnavailable(families));
  }, [missingFonts, fitPage, fontsUnavailable]);

  const checkDocument = useCallback(() => {
    const editor = editorRef.current;
    const layout = editor?.getEditorRef()?.getLayout() ?? null;
    if (editor && containerRef.current && layout && layout !== lastPaintedLayout.current && decorateWordFields(containerRef.current, editor, metadataRef.current)) lastPaintedLayout.current = layout;
    const document = editorRef.current?.getDocument();
    if (!document || document === lastDocument.current) return;
    const hadDocument = lastDocument.current !== null;
    lastDocument.current = document;
    if (hadDocument) markDirty();
  }, [markDirty]);

  // The pinned adapter omits onChange for some header/footer and property-dialog
  // edits. Its immutable document reference covers those paths without serializing
  // or traversing a large contract on every keystroke. Check synchronously before save too.
  useEffect(() => {
    const timer = window.setInterval(checkDocument, 250);
    return () => window.clearInterval(timer);
  }, [checkDocument]);

  const [exporter] = useState(() => createDocumentExport(() => revision.current, async () => {
      const editor = editorRef.current; const doc = editor?.getEditorRef()?.getView()?.state.doc; const document = editor?.getDocument();
      const metadata = structuredClone(metadataRef.current);
      const buffer = await editorRef.current?.save({ selective: false });
      return buffer ? await finalizeWordPackage(doc && document ? await preserveWordFormatting(buffer, doc, document) : buffer, metadata) : null;
  }, value => value !== null));
  const getBuffer = useCallback(() => exporter.read(), [exporter]);

  const syncTracking = (active: boolean) => {
    const paged = editorRef.current?.getEditorRef();
    const body = paged?.getView();
    if (body) setSuggestionMode(active, body.state, body.dispatch, reviewer.trim() || "LegalWork");
    for (const view of paged?.getHfPmViews().values() ?? []) {
      if (!suggestionModeKey.getState(view.state) && metadataRef.current.protection.mode === "trackedChanges") view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, createSuggestionModePlugin(active, reviewer.trim() || "LegalWork")] }));
      if (suggestionModeKey.getState(view.state)) setSuggestionMode(active, view.state, view.dispatch, reviewer.trim() || "LegalWork");
    }
  };
  const changeProtection = (protection: Protection) => {
    const metadata = { ...metadataRef.current, protection };
    metadataRef.current = metadata; setWordMetadata(metadata);
    if (protection.mode === "trackedChanges") { setMode("suggesting"); syncTracking(true); }
    markDirty();
  };
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    let frame = 0;
    const paint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const editor = editorRef.current;
        if (!editor) return;
        for (const view of editor.getEditorRef()?.getHfPmViews().values() ?? []) if (!view.state.plugins.includes(protectionPlugin)) {
          const tracking = suggestionModeKey.getState(view.state) || metadataRef.current.protection.mode !== "trackedChanges" ? [] : [createSuggestionModePlugin(true, reviewer.trim() || "LegalWork")];
          view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins, ...tracking, protectionPlugin] }));
        }
        decorateWordFields(host, editor, metadataRef.current);
      });
    };
    host.addEventListener("painter:painted", paint);
    paint();
    return () => { host.removeEventListener("painter:painted", paint); cancelAnimationFrame(frame); };
  }, [metadataReady, protectionPlugin]);

  const navigateReference = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const download = target.closest('[role="menuitem"]');
    if (download?.textContent?.trim() === t("artifact.download_copy")) {
      event.preventDefault(); event.stopPropagation();
      void getBuffer().then((buffer) => { if (buffer) downloadDocx(buffer, name); }).catch((error) => toast.error(String(error)));
      return;
    }
    const bookmark = target.closest<HTMLElement>("[data-word-bookmark]")?.dataset.wordBookmark
      ?? target.closest<HTMLAnchorElement>('a[href^="#"]')?.getAttribute("href")?.slice(1);
    if (!bookmark) { onReviewClick(event); return; }
    const view = editorRef.current?.getEditorRef()?.getView();
    const mark = view && wordBookmarks(view.state.doc).find(mark => mark.name === bookmark);
    if (mark) { event.preventDefault(); event.stopPropagation(); editorRef.current?.highlightRange(mark.from, mark.from); }
  };

  checkpoint.current = () => {
    const work = (async () => {
      if (!recoveryKey || !dirty.current || readOnly) return;
      const checkpointRevision = revision.current;
      if (checkpointed.current?.revision === checkpointRevision && checkpointed.current.base === baseUpdatedAt) return;
      try {
        const buffer = await getBuffer();
        if (!buffer || !dirty.current || checkpointRevision !== revision.current) return;
        await writeDocxRecovery({ key: recoveryKey, buffer, baseUpdatedAt, savedAt: Date.now() });
        checkpointed.current = { revision: checkpointRevision, base: baseUpdatedAt };
        recoveryFailed.current = false;
      } catch {
        if (!recoveryFailed.current) toast.error(t("docx.recovery_unavailable_save"));
        recoveryFailed.current = true;
      }
    })();
    checkpointWork.current = work;
    return work;
  };

  useLayoutEffect(() => {
    const onHidden = () => { if (document.visibilityState === "hidden") void checkpoint.current(); };
    const timer = setInterval(() => { void checkpoint.current(); }, 5000);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      clearInterval(timer);
      if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
      void checkpoint.current();
    };
  }, []);

  const save = useCallback((automatic = false): Promise<boolean> => {
    if (pendingSave.current) return pendingSave.current.then((saved) => saved && dirty.current ? save(automatic) : saved);
    if (readOnly || !onSave) return Promise.resolve(false);
    checkDocument();
    const savingRevision = revision.current;
    const operation = (async () => {
      const buffer = await getBuffer();
      if (!buffer) return false;
      if (recoveryKey && !historyStarted.current && !recovered) {
        await keepDocxVersion(recoveryKey, documentBuffer.slice(0)).catch(() => toast.error(t("docx.saved_no_history")));
        historyStarted.current = true;
      }
      await onSave(buffer);
      if (recoveryKey) void keepDocxVersion(recoveryKey, buffer.slice(0), automatic).catch(() => toast.error(t("docx.saved_no_history")));
      checkDocument();
      if (revision.current === savingRevision) {
        dirty.current = false;
        onDirtyChange?.(false);
        if (recoveryKey) await removeDocxRecovery(recoveryKey).catch(() => toast.error(t("docx.saved_recovery_not_cleared")));
      }
      automaticSave.saved();
      onAutosaveError?.(null);
      return true;
    })();
    pendingSave.current = operation.finally(() => { pendingSave.current = null; });
    return pendingSave.current;
  }, [readOnly, onSave, checkDocument, getBuffer, onDirtyChange, recoveryKey, automaticSave, onAutosaveError, recovered, documentBuffer]);
  latestSave.current = () => save(true);

  useEffect(() => {
    automaticSave.setEnabled(autosave);
    latestAutosaveError.current?.(null);
  }, [automaticSave, autosave]);

  useEffect(() => {
    automaticSave.setSuspended(readOnly || interactionLocked);
  }, [automaticSave, readOnly, interactionLocked]);

  useEffect(() => {
    const flush = () => { if (document.visibilityState === "hidden") void automaticSave.flush(); };
    document.addEventListener("visibilitychange", flush);
    return () => { automaticSave.setSuspended(true); document.removeEventListener("visibilitychange", flush); };
  }, [automaticSave]);

  useEffect(() => {
    if (!apiRef) return;
    const executeAgentTool = async (toolName: string, args: Record<string, unknown>, persist: boolean, options: DocumentTaskOptions = {}): Promise<DocxEditorToolResult> => {
      checkDocumentTask(options);
      if ((readOnly || interactionLocked) && !isDocumentReadTool("docx", toolName)) return { success: false, error: t("docx.read_only") };
      if (!ready.current) return { success: false, error: t("docx.editor_not_ready") };
      checkDocument();
      if (toolName === "edit") {
        if (args.documentId !== documentId || args.draftRevision !== revision.current) return { success: false, error: t("docx.read_draft_again") };
        automaticSave.setSuspended(true);
        try { return await executeWordBatch(args, (name, input, save) => executeAgentTool(name, input, save, name === "save_document" ? {} : options)); }
        catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) }; }
        finally { automaticSave.setSuspended(readOnly || interactionLocked); }
      }
      const mutatesStructure = WORD_STRUCTURE_MUTATIONS.has(toolName) || ["apply_formatting", "update_fields", "set_page_numbering", "set_protection", "set_paragraph_style", "insert_break", "save_document"].includes(toolName);
      const mutatesDocument = SDK_MUTATIONS.has(toolName) || toolName === "fill_template" || REVIEW_TOOL_NAMES.has(toolName) || mutatesStructure;
      if (readOnly && mutatesDocument) return { success: false, error: t("docx.read_only") };
      if ((mutatesStructure || COPY_TOOLS.has(toolName)) && (args.documentId !== documentId || args.draftRevision !== revision.current)) return { success: false, error: t("docx.read_draft_again") };
      const editor = editorRef.current; const view = editor?.getEditorRef()?.getView(); const document = editor?.getDocument();
      if (!editor || !view || !document) return { success: false, error: t("docx.editor_not_ready") };
      const structure = () => {
        const current = editor.getDocument() ?? document;
        const hfViews = editor.getEditorRef()?.getHfPmViews();
        const stories = new Map([...current.package.headers ?? [], ...current.package.footers ?? []]);
        return { documentId, draftRevision: revision.current, editorEditable: !readOnly && !interactionLocked, ...readWordStructure(view.state.doc, current, editor.getEditorRef()?.getLayout() ?? null, metadataRef.current), headerFooterFields: Array.from(stories).flatMap(([rid, story]) => readWordStructure(hfViews?.get(rid)?.state.doc ?? headerFooterToProseDoc(story.content, { styles: current.package.styles }), current, null, metadataRef.current, rid, view.state.doc, false).fields) };
      };
      if (toolName === "read_document") {
        try {
          const read = readWordDocument(view.state.doc, document, editor.getEditorRef()?.getLayout() ?? null, metadataRef.current, args, new Map(Array.from(editor.getEditorRef()?.getHfPmViews() ?? []).map(([rid, view]) => [rid, view.state.doc])));
          const { textArgs, ...native } = read;
          const text = read.view === "all" || read.view === "text" ? executeToolCall("read_document", textArgs) : undefined;
          if (text && !text.success) return text;
          return { success: true, data: { documentId, draftRevision: revision.current, editorEditable: !readOnly && !interactionLocked, ...native, nextIndex: native.coverage.nextIndex,
            text: text?.data, comments: read.view === "all" ? editor.getComments() : undefined, changes: read.view === "all" ? executeToolCall("read_changes", {}).data : undefined } };
        } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) }; }
      }
      if (toolName === "read_structure") return { success: true, data: structure() };
      if (toolName === "read_formatting") {
        try { return { success: true, data: { documentId, draftRevision: revision.current, editorEditable: !readOnly && !interactionLocked, ...readWordFormatting(view.state.doc, document, args) } }; }
        catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) }; }
      }
      if (toolName === "save_document") {
        try { const saved = await save(); return saved && !dirty.current ? { success: true, saved: true, data: { documentId, draftRevision: revision.current } } : { success: false, saved: false, error: t("docx.changed_not_saved") }; }
        catch (cause) { return { success: false, saved: false, error: `${t("docx.changed_not_saved")} ${cause instanceof Error ? cause.message : String(cause)}` }; }
      }
      if (toolName === "inspect_document") {
        const draftRevision = revision.current; const buffer = await getBuffer();
        if (!buffer || draftRevision !== revision.current) return { success: false, error: t("docx.read_draft_again") };
        return { success: true, data: { documentId, draftRevision, findings: await inspectWordPackage(buffer) } };
      }
      if (COPY_TOOLS.has(toolName)) {
        try {
          const draftRevision = revision.current; const buffer = await getBuffer();
          if (!buffer || draftRevision !== revision.current) return { success: false, error: t("docx.read_draft_again") };
          let copy: ArrayBuffer;
          if (toolName === "create_clean_copy") {
            const categories = args.categories;
            const selected: InspectionKind[] = [];
            if (!Array.isArray(categories) || !categories.length) throw new Error("Select inspection categories explicitly.");
            for (const kind of categories) {
              if (kind !== "properties" && kind !== "hiddenText" && kind !== "customXml" && kind !== "comments" && kind !== "revisions") throw new Error("Unsupported inspection category.");
              selected.push(kind);
            }
            const clean = selected.includes("revisions") || selected.includes("comments") ? await createCleanDocx(buffer, { acceptChanges: selected.includes("revisions"), removeComments: selected.includes("comments") }) : buffer;
            copy = await removeWordPrivateData(clean, selected);
            if ((await inspectWordPackage(copy)).some((finding) => selected.includes(finding.kind))) throw new Error(t("docx.word.inspection_incomplete"));
          } else {
            if (!Array.isArray(args.versions) || !args.versions.length || args.versions.length > 8) throw new Error("Provide between one and eight returned drafts.");
            const versions = args.versions.map((version: unknown) => {
              if (!version || typeof version !== "object" || !("base64" in version) || typeof version.base64 !== "string" || version.base64.length > 40_000_000 || !("author" in version) || typeof version.author !== "string") throw new Error("Invalid returned draft.");
              return { buffer: Uint8Array.from(atob(version.base64), (char) => char.charCodeAt(0)).buffer, author: version.author };
            });
            copy = versions.length === 1 ? await compareWordDocuments(buffer, versions[0].buffer, versions[0].author) : await combineWordDocuments(buffer, versions);
          }
          if (draftRevision !== revision.current) return { success: false, error: t("docx.read_draft_again") };
          const reviewer = await DocxReviewer.fromBuffer(copy);
          return { success: true, data: { bufferBase64: encodeWordCopy(copy), changes: reviewer.getChanges(), findings: await inspectWordPackage(copy), sourceChanged: false } };
        } catch (cause) { return { success: false, error: cause instanceof Error ? cause.message : String(cause) }; }
      }
      const isReviewDecision = REVIEW_TOOL_NAMES.has(toolName);
      if (isReviewDecision && metadataRef.current.protection.mode === "trackedChanges") return { success: false, error: t("docx.word.edit_blocked") };
      const before = view.state.doc;
      const beforeMetadata = metadataRef.current;
      let result: DocxEditorToolResult;
      try {
        if (toolName === "fill_template" && (args.controlId !== undefined || args.tag !== undefined)) {
          const fill = docxTemplateSchema.parse(args);
          if (fill.documentId !== documentId || fill.draftRevision !== revision.current) return { success: false, error: t("docx.read_draft_again") };
          const controls = readWordStructure(view.state.doc, document, null, metadataRef.current).controls.filter(control => fill.controlId !== undefined ? control.id === fill.controlId : control.tag === fill.tag);
          if (controls.length !== 1) return { success: false, error: "The control ID/tag must identify exactly one native text control." };
          result = flushEditorUpdate(() => executeWordStructureTool({ view, document, layout: editor.getEditorRef()?.getLayout() ?? null, metadata: metadataRef.current, loadDocument: next => editor.loadDocument(next) }, "fill_content_control", { controlId: controls[0].id, text: fill.value }));
        } else if (toolName === "fill_template") {
          if (typeof args.paraId !== "string" || typeof args.placeholder !== "string" || !/^(?:\{\{[^{}]+\}\}|\[\[[^\[\]]+\]\]|\[[^\[\]]+\])$/.test(args.placeholder) || typeof args.value !== "string") {
            return { success: false, error: "Use an exact template placeholder, its paragraph ID and the replacement value." };
          }
          const view = editorRef.current?.getEditorRef()?.getView();
          if (!view) return { success: false, error: t("docx.editor_not_ready") };
          const existing = templateRevisionIds(view.state);
          result = flushEditorUpdate(() => executeToolCall("suggest_change", { paraId: args.paraId, search: args.placeholder, replaceWith: args.value }));
          if (result.success) {
            const normalized = normalizeDocxLineBreaks(view.state);
            if (normalized) flushEditorUpdate(() => view.dispatch(normalized));
            const accepted = flushEditorUpdate(() => acceptTemplateRevisions(view, existing));
            if (!accepted) return { success: false, error: "The replacement could not be finalized. Read the current draft before continuing." };
            result = { success: true, data: { placeholder: args.placeholder, value: args.value } };
          }
        } else if (toolName === "reply_comment") {
          if (!Number.isInteger(args.commentId) || typeof args.commentId !== "number" || args.commentId < 0 || typeof args.text !== "string" || !args.text.trim()) {
            return { success: false, error: "A valid comment ID and reply text are required." };
          }
          // Replies live in the editor's React comment state. Flush that update
          // before serializing, otherwise the save can omit the new reply.
          const commentId = args.commentId;
          const text = args.text;
          const id = flushEditorUpdate(() => editorRef.current?.replyToComment(commentId, text, "LegalWork AI"));
          result = id === null || id === undefined ? { success: false, error: "The comment no longer exists. Read the comments again." } : { success: true, data: { commentId: id, parentId: args.commentId } };
        } else if (WORD_STRUCTURE_MUTATIONS.has(toolName)) {
          result = flushEditorUpdate(() => executeWordStructureTool({ view, document, layout: editor.getEditorRef()?.getLayout() ?? null, metadata: metadataRef.current, loadDocument: (document) => editor.loadDocument(document) }, toolName, args));
        } else if (toolName === "apply_formatting") {
          result = flushEditorUpdate(() => applyWordFormatting({ view, document, layout: editor.getEditorRef()?.getLayout() ?? null, metadata: metadataRef.current, loadDocument: (document) => editor.loadDocument(document) }, args));
        } else if (toolName === "update_fields") {
          result = { success: true, data: { updated: await updateWordFields(editor, metadataRef.current, flushEditorUpdate) } };
        } else if (toolName === "set_protection") {
          const mode = args.mode;
          if (metadataRef.current.protection.password || mode !== "none" && mode !== "forms" && mode !== "trackedChanges") return { success: false, error: "Password protection cannot be changed by this tool, or the mode is unsupported." };
          flushEditorUpdate(() => changeProtection({ mode, password: false }));
          result = { success: true, data: { protection: metadataRef.current.protection } };
        } else if (toolName === "set_page_numbering") {
          if (metadataRef.current.protection.mode !== "none") return { success: false, error: t("docx.word.edit_blocked") };
          const index = args.sectionIndex; const format = args.format; const start = args.start;
          if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= metadataRef.current.pages.length || typeof format !== "string" || !["decimal", "decimalZero", "upperRoman", "lowerRoman", "upperLetter", "lowerLetter"].includes(format) || start !== undefined && start !== null && (typeof start !== "number" || !Number.isInteger(start) || start < 1 || start > 32767)) return { success: false, error: "Invalid section index, page format or restart number." };
          const metadata = { ...metadataRef.current, pages: metadataRef.current.pages.map((rule, i) => i === index ? { format, ...(typeof start === "number" ? { start } : {}) } : rule) };
          metadataRef.current = metadata; setWordMetadata(metadata);
          await updateWordFields(editor, metadata, flushEditorUpdate);
          result = { success: true, data: { sections: metadata.pages, tracked: false } };
        } else if (isReviewDecision) {
          const changeIds = requestedChangeIds(args);
          if (!changeIds) {
            return { success: false, error: t("docx.change_ids_required") };
          }
          result = flushEditorUpdate(() => decideTrackedChanges(
            editorRef.current,
            toolName === "accept_changes" ? "accept" : "reject",
            changeIds,
          ));
        } else {
          if (["set_paragraph_style", "insert_break"].includes(toolName) && metadataRef.current.protection.mode !== "none") return { success: false, error: t("docx.word.edit_blocked") };
          result = isDocumentReadTool("docx", toolName) ? executeToolCall(toolName, args) : flushEditorUpdate(() => executeToolCall(toolName, args));
          if (result.success && toolName === "insert_break" && args.type !== "page") {
            let target = -1; let section = 0;
            before.descendants((node, pos) => { if (node.attrs.paraId === args.paraId) target = pos; });
            before.descendants((node, pos) => { if (pos < target && node.attrs.sectionBreakType) section++; });
            const pages = [...metadataRef.current.pages];
            pages.splice(section + 1, 0, { format: pages[section]?.format ?? "decimal" });
            const metadata = { ...metadataRef.current, pages }; metadataRef.current = metadata; setWordMetadata(metadata);
          }
        }
      } catch (cause) {
        const applied = before !== editorRef.current?.getEditorRef()?.getView()?.state.doc || beforeMetadata !== metadataRef.current;
        if (applied) { markDirty(); checkDocument(); }
        return { success: false, data: { applied, documentId, draftRevision: revision.current }, error: cause instanceof Error ? cause.message : String(cause) };
      }
      if (!result.success) return result;
      if ((toolName === "suggest_change" || ["set_paragraph_style", "insert_break"].includes(toolName) || isReviewDecision) && before === editorRef.current?.getEditorRef()?.getView()?.state.doc) return { success: false, error: t("docx.word.edit_blocked") };

      if (!mutatesDocument) return result;
      if (result.data && typeof result.data === "object" && Reflect.get(result.data, "applied") === false) return { ...result, saved: !dirty.current, data: { result: result.data, documentId, draftRevision: revision.current } };
      const currentView = editorRef.current?.getEditorRef()?.getView();
      const normalized = currentView && normalizeDocxLineBreaks(currentView.state);
      if (normalized) flushEditorUpdate(() => currentView.dispatch(normalized));
      markDirty();
      checkDocument();
      if (!persist) return { ...result, data: { result: result.data, documentId, draftRevision: revision.current } };
      let saved: boolean;
      try { saved = await save(); }
      catch (cause) { return { success: false, saved: false, data: { applied: true, documentId, draftRevision: revision.current }, error: `${t("docx.changed_not_saved")} ${cause instanceof Error ? cause.message : String(cause)}` }; }
      if (!saved || dirty.current) return { success: false, saved: false, data: { applied: true, documentId, draftRevision: revision.current }, error: t("docx.changed_not_saved") };
      return { ...result, data: { result: result.data, documentId, draftRevision: revision.current }, saved: true };

    };
    apiRef.current = { navigate: async (rawTarget) => {
      const target = documentNavigationTargetSchema.parse(rawTarget);
      if (target.kind !== "page") throw new Error("Word navigation requires a page number.");
      if (!ready.current) throw new Error("The document is still loading.");
      const pages = containerRef.current?.querySelectorAll<HTMLElement>(".layout-page");
      const page = pages?.[target.page - 1];
      if (!page) throw new Error(`Page ${target.page} is unavailable. The current layout has ${pages?.length ?? 0} pages.`);
      page.scrollIntoView({ block: "start", behavior: "instant" });
      return { page: target.page, pageCount: pages!.length };
    }, save, getBuffer, revision: () => { checkDocument(); return revision.current; }, isDirty: () => { checkDocument(); return dirty.current; },
      flushSave: async () => {
        if (pendingSave.current && !await pendingSave.current) return false;
        checkDocument();
        if (dirty.current && !await save()) return false;
        await checkpointWork.current;
        await drainDocxRecovery();
        return ready.current && !dirty.current;
      },
      drain: async () => {
        try { await pendingSave.current; } finally { await checkpointWork.current; await drainDocxRecovery(); }
      },
      isReady: () => ready.current,
      executeAgentTool: (toolName, args, options) => executeAgentTool(toolName, args, true, options),
    discardRecovery: async () => {
      await checkpointWork.current;
      if (recoveryKey) await removeDocxRecovery(recoveryKey);
      dirty.current = false;
      onDirtyChange?.(false);
    } };
    return () => { apiRef.current = null; };
  }, [apiRef, save, getBuffer, onDirtyChange, recoveryKey, executeToolCall, markDirty, readOnly, interactionLocked, documentId, checkDocument, automaticSave]);

  useControlActions([
    {
      id: "document.read_metadata", label: "Read document status and page count", sideEffect: "none",
      description: "Read the open DOCX name, revision, unsaved-edit status and rendered page count without serializing its text. pageCount is null while pagination is unavailable. Use for report delivery checks; wait for a stable revision/page count.",
      execute: () => {
        const pages = containerRef.current?.querySelectorAll(".layout-page").length ?? 0;
        return { name, documentId, draftRevision: revision.current, saved: !dirty.current,
          pageCount: ready.current && pages > 0 ? pages : null };
      },
    },
    {
      id: "document.read_draft", label: "Read the open document draft", sideEffect: "none",
      description: "Read the live DOCX, including unsaved edits, rendered page count, paragraph handles, comments and redlines. pageCount is null while pagination is unavailable. Use this instead of reading the older workspace file.",
      execute: async () => {
        const draftRevision = revision.current;
        const buffer = await getBuffer();
        if (!buffer) throw new Error(t("docx.still_loading"));
        const draft = await DocxReviewer.fromBuffer(buffer);
        if (draftRevision !== revision.current) throw new Error(t("docx.draft_changed_while_reading"));
        const pages = containerRef.current?.querySelectorAll(".layout-page").length ?? 0;
        return { name, documentId, draftRevision, pageCount: ready.current && pages > 0 ? pages : null,
          text: draft.getContentAsText(), comments: draft.getComments(), changes: draft.getChanges(),
          structure: editorRef.current?.getDocument() && editorRef.current.getEditorRef()?.getView() ? readWordStructure(editorRef.current.getEditorRef()!.getView()!.state.doc, editorRef.current.getDocument()!, editorRef.current.getEditorRef()!.getLayout(), metadataRef.current) : null };
      },
    },
    {
      id: "document.propose_change", label: "Propose a change in the open document", sideEffect: "mutation", disabled: readOnly || interactionLocked,
      description: "Apply and save a tracked proposal to the current draft. Requires name, documentId and draftRevision from document.read_draft. The lawyer reviews it with Accept/Reject. Saving does not accept the proposal.",
      requiresArgs: true,
      args: [{ name: "name", type: "string", required: true }, { name: "documentId", type: "string", required: true }, { name: "draftRevision", type: "number", required: true }, { name: "paraId", type: "string", required: true }, { name: "search", type: "string", required: true }, { name: "replaceWith", type: "string", required: true }],
      execute: async (args) => {
        if (readOnly || interactionLocked) throw new Error(t("docx.read_only"));
        if (!args || typeof args !== "object" || !("name" in args) || args.name !== name ||
          !("documentId" in args) || args.documentId !== documentId ||
          !("draftRevision" in args) || args.draftRevision !== revision.current ||
          !("paraId" in args) || typeof args.paraId !== "string" ||
          !("search" in args) || typeof args.search !== "string" ||
          !("replaceWith" in args) || typeof args.replaceWith !== "string") throw new Error(t("docx.read_draft_again"));
        const proposal = { paraId: args.paraId, search: args.search, replaceWith: args.replaceWith, author: "LegalWork AI" };
        const applied = flushEditorUpdate(() => editorRef.current?.proposeChange(proposal));
        if (!applied) throw new Error(t("docx.target_ambiguous"));
        const view = editorRef.current?.getEditorRef()?.getView();
        const normalized = view && normalizeDocxLineBreaks(view.state);
        if (normalized) flushEditorUpdate(() => view.dispatch(normalized));
        markDirty();
        if (!await save()) throw new Error(t("docx.changed_not_saved"));
        return { applied: true, saved: true, draftRevision: revision.current };
      },
    },
  ]);

  return (
    <div ref={containerRef} className="docx-host flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden" onClickCapture={navigateReference} onDoubleClickCapture={(event) => {
      if (event.target instanceof Element && editorRef.current && containerRef.current && navigateWordNote(event.target, containerRef.current, editorRef.current)) { event.preventDefault(); event.stopPropagation(); }
    }} onKeyDownCapture={(event) => {
      if (event.key === "Enter" && event.target instanceof HTMLElement && event.target.getAttribute("role") === "link") {
        if (event.target.dataset.wordBookmark) event.target.click();
        else if (editorRef.current && containerRef.current) navigateWordNote(event.target, containerRef.current, editorRef.current);
        event.preventDefault(); event.stopPropagation(); return;
      }

      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (readOnly || interactionLocked) return;
      void save().then((saved) => {
        if (!saved) toast.error(t("docx.save_failed_draft_open"));
      }).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : t("docx.save_failed_draft_open"));
      });
    }}>
      {metadataReady && visible && <div className="docx-word-tools flex flex-wrap items-center gap-2 border-b border-border px-3 py-1" role="toolbar" aria-label={t("docx.word.tools")}>
        <DocxWordTools editorRef={editorRef} metadata={wordMetadata} readOnly={readOnly || interactionLocked} onChanged={markDirty} />
        {changeCount > 0 && <>
        <Button size="sm" variant="ghost" aria-pressed={commentsOpen} onClick={() => setCommentsOpen(!commentsOpen)}>{t("docx.review_changes")} ({changeCount})</Button>
        {!readOnly && (["accept", "reject"] satisfies Array<"accept" | "reject">).map(decision => <Button key={decision} size="sm" variant="ghost" disabled={interactionLocked || wordMetadata.protection.mode === "trackedChanges"} onClick={() => {
          const view = editorRef.current?.getEditorRef()?.getView();
          if (!view) return;
          const ids = extractTrackedChanges(view.state).entries.map(entry => Number(entry.revisionId)).filter(Number.isFinite);
          setReviewDecision({ decision, ids, revision: revision.current });
        }}>{t(decision === "accept" ? "docx.accept_all" : "docx.reject_all")}</Button>)}
        </>}
      </div>}
      <div className="min-h-0 min-w-0 flex-1">
        {!metadataReady ? <p role="status" className="p-4">{metadataError || t("docx.word.working")}</p> : <DocxEditor
          ref={editorRef}
          documentBuffer={documentBuffer}
          documentName={name}
          documentNameEditable={false}
          author={reviewer.trim() || "LegalWork"}
          externalPlugins={wordPlugins}
          readOnly={readOnly || interactionLocked || ["readOnly", "comments"].includes(wordMetadata.protection.mode)}
          mode={readOnly || interactionLocked || ["readOnly", "comments"].includes(wordMetadata.protection.mode) ? "viewing" : mode}
          onModeChange={(next) => {
            if (metadataRef.current.protection.mode === "trackedChanges" && next !== "suggesting") { setMode("suggesting"); syncTracking(true); toast.error(t("docx.word.edit_blocked")); return; }
            setMode(next);
          }}
          commentsSidebarOpen={commentsOpen}
          onCommentsSidebarOpenChange={setCommentsOpen}
          onFontsLoaded={fitPage}
          colorMode={colorMode}
          showFileOpen={false}
          showHelpMenu
          showOutlineButton
          showRuler={false}
          rulerUnit="cm"
          i18n={EDITOR_LABELS}
          className="h-full"
          onEditorViewReady={(view) => {
            view.dom.inert = !visibleRef.current;
            if (!visibleRef.current) view.dom.setAttribute("aria-hidden", "true");
            const normalized = normalizeDocxLineBreaks(view.state);
            if (normalized) view.dispatch(normalized.setMeta("addToHistory", false));
            // Plugins may retain a dispatch callback after React unmounts the
            // editor. The pinned editor resets its teardown flag after destroy;
            // reject those late transactions before ProseMirror reads docView.
            const dispatch = view.props.dispatchTransaction;
            view.setProps({ dispatchTransaction(transaction) {
              if (view.isDestroyed) return;
              if (dispatch) dispatch.call(view, transaction);
              else view.updateState(view.state.apply(transaction));
            } });
            // Initial import/normalization emits document and comment callbacks.
            // Establish the baseline after that first render, before accepting edits.
            requestAnimationFrame(() => {
              if (view.isDestroyed || ready.current) return;
              lastDocument.current = editorRef.current?.getDocument() ?? null;
              ready.current = true;
              setChangeCount(extractTrackedChanges(view.state).entries.length);
              askAboutFonts();
              if (recovered) { dirty.current = true; onDirtyChange?.(true); automaticSave.changed(); }
            });
          }}
          onChange={(document) => { lastDocument.current = document; markDirty(); }}
          onCommentsChange={() => {
            // Loading the imported threads happens before the editor ref has a document.
            if (editorRef.current?.getDocument()) markDirty();
          }}
          onError={(error) => toast.error(error.message)}
        />}
      </div>
      <ConfirmModal
        open={visible && reviewDecision !== null}
        title={t(reviewDecision?.decision === "reject" ? "docx.reject_all" : "docx.accept_all")}
        message={t("docx.review_all_confirm")}
        confirmLabel={t(reviewDecision?.decision === "reject" ? "docx.reject_all" : "docx.accept_all")}
        cancelLabel={t("common.cancel")}
        onCancel={() => setReviewDecision(null)}
        onConfirm={() => {
          const pending = reviewDecision;
          setReviewDecision(null);
          if (!pending || readOnly || interactionLocked || metadataRef.current.protection.mode === "trackedChanges") return;
          if (pending.revision !== revision.current) { toast.error(t("docx.read_draft_again")); return; }
          const result = flushEditorUpdate(() => decideTrackedChanges(editorRef.current, pending.decision, pending.ids));
          if (!result.success) { toast.error(result.error); return; }
          markDirty();
          void save().then(saved => { if (!saved) toast.error(t("docx.changed_not_saved")); }).catch(error => toast.error(error instanceof Error ? error.message : t("docx.changed_not_saved")));
        }}
      />
      <ConfirmModal
        open={visible && missingFonts.length > 0}
        title={t("docx.font_missing_title", { count: missingFonts.length })}
        message={t("docx.font_missing_body", { count: missingFonts.length, fonts: missingFonts.join(", ") })}
        confirmLabel={t("docx.font_missing_confirm", { count: missingFonts.length })}
        cancelLabel={t("docx.font_missing_cancel", { count: missingFonts.length })}
        confirmButtonVariant="secondary"
        onConfirm={() => resolveFonts(true)}
        onCancel={() => resolveFonts(false)}
      />
    </div>
  );
}
