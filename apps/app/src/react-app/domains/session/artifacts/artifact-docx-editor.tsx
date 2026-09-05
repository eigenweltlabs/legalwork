/** @jsxImportSource react */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { DocxEditor, type DocxEditorRef, type EditorMode } from "@eigenpal/docx-editor-react";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { useDocxAgentTools } from "@eigenpal/docx-editor-agents/react";
import { acceptChangeById, rejectChangeById } from "@eigenpal/docx-editor-core/prosemirror/commands";
import { extractTrackedChanges } from "@eigenpal/docx-editor-core/prosemirror/utils/extractTrackedChanges";
import "@eigenpal/docx-editor-react/styles.css";

import { getInitialThemeMode, subscribeToTheme, type ThemeMode } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { keepDocxVersion, readDocxRecovery, removeDocxRecovery, writeDocxRecovery, type DocxRecovery } from "./docx-recovery";
import { useDocxPageFit } from "./use-docx-page-fit";
import { useDocxReviewCard } from "./use-docx-review-card";
import "./docx-editor-layout.css";
import { useControlActions } from "../../../shell/control/control-provider";

export type DocxEditorApi = {
  /** Serialize and persist the current document. Never clears edits made during a save. */
  save: () => Promise<boolean>;
  /** Serialize the live draft without writing to the workspace or clearing its dirty state. */
  getBuffer: () => Promise<ArrayBuffer | null>;
  executeAgentTool: (toolName: string, args: Record<string, unknown>) => Promise<DocxEditorToolResult>;
  discardRecovery: () => void;
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
  onSave?: (buffer: ArrayBuffer) => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  apiRef?: RefObject<DocxEditorApi | null>;
  recoveryKey?: string;
  baseUpdatedAt?: number | null;
  onRestore?: (baseUpdatedAt: number | null) => void;
};

const AUTHOR_KEY = "legalwork.docx.reviewer";
let documentInstance = 0;
// Eigenpal's File > Save exports a download, even when onSave is supplied.
// Name that action accurately; the panel Save button / Cmd+S persist to the workspace.
const EDITOR_LABELS = { toolbar: { save: "Download copy", saveShortcut: "" } };

const REVIEW_TOOL_NAMES = new Set(["accept_changes", "reject_changes"]);

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
  if (!view) return { success: false, error: "The document editor is not ready." };

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
    return { success: false, error: "None of those tracked-change IDs exist in the open document." };
  }
  const verb = decision === "accept" ? "Accepted" : "Rejected";
  return { success: true, data: `${verb} ${applied} tracked-change revision${applied === 1 ? "" : "s"}.` };
}

function useThemeColorMode(): ThemeMode {
  return useSyncExternalStore(subscribeToTheme, getInitialThemeMode, getInitialThemeMode);
}

export function ArtifactDocxEditor(props: ArtifactDocxEditorProps) {
  const [recovery, setRecovery] = useState<DocxRecovery | null>(null);
  const [checked, setChecked] = useState(Boolean(!props.recoveryKey || props.readOnly));
  const [restored, setRestored] = useState<DocxRecovery | null>(null);
  useEffect(() => {
    if (!props.recoveryKey || props.readOnly) { setChecked(true); return; }
    let active = true;
    void readDocxRecovery(props.recoveryKey).then((draft) => {
      if (active) { setRecovery(draft); setChecked(true); }
    }).catch(() => {
      if (active) { setChecked(true); toast.error("Draft recovery is unavailable on this device. Save frequently."); }
    });
    return () => { active = false; };
  }, [props.recoveryKey, props.readOnly]);
  if (!checked) return <div className="p-6 text-sm" role="status">Checking for an unsaved draft…</div>;
  if (recovery) return <div className="space-y-4 p-6">
    <h3 className="font-medium">Recover your unsaved draft?</h3>
    <p className="text-sm text-muted-foreground">A draft of {props.name} was kept on this device at {new Date(recovery.savedAt).toLocaleString()}. Restoring it does not overwrite the workspace file.</p>
    {recovery.baseUpdatedAt !== props.baseUpdatedAt && <p className="text-sm">The workspace file has changed. You can recover and download your draft; saving over the newer file will be blocked.</p>}
    <div className="flex gap-2">
      <Button onClick={() => { props.onRestore?.(recovery.baseUpdatedAt); setRestored(recovery); setRecovery(null); }}>Recover draft</Button>
      <Button variant="outline" onClick={() => {
        void removeDocxRecovery(recovery.key).then(() => setRecovery(null)).catch(() => toast.error("Could not discard the recovery copy. Try again."));
      }}>Discard draft and open file</Button>
    </div>
  </div>;
  return <LiveDocxEditor {...props} content={restored?.buffer ?? props.content} recovered={!!restored} />;
}

function LiveDocxEditor({ name, content, author, readOnly = false, onSave, onDirtyChange, apiRef, recoveryKey, baseUpdatedAt = null, recovered }: ArtifactDocxEditorProps & { recovered: boolean }) {
  const colorMode = useThemeColorMode();
  const [documentBuffer] = useState(() => content.slice(0));
  const [documentId] = useState(() => `${Date.now()}:${++documentInstance}`);
  const [mode, setMode] = useState<EditorMode>("editing");
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(recovered);
  const checkpoint = useRef<() => Promise<void>>(async () => {});
  const checkpointed = useRef<{ revision: number; base: number | null } | null>(null);
  const [reviewer] = useState(() => {
    if (author) return author;
    try { return window.localStorage.getItem(AUTHOR_KEY) ?? ""; } catch { return ""; }
  });
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const fitPage = useDocxPageFit(containerRef, editorRef, commentsOpen);
  const onReviewClick = useDocxReviewCard(containerRef, editorRef);
  const recoveryFailed = useRef(false);
  const { executeToolCall } = useDocxAgentTools({ editorRef, author: "LegalWork AI" });
  const revision = useRef(0);
  const ready = useRef(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const serialization = useRef<Promise<ArrayBuffer | null> | null>(null);
  const lastDocument = useRef<ReturnType<DocxEditorRef["getDocument"]>>(null);

  const markDirty = useCallback(() => {
    if (readOnly || !ready.current) return;
    revision.current += 1;
    dirty.current = true;
    onDirtyChange?.(true);
    if (recoveryKey) {
      if (checkpointTimer.current) clearTimeout(checkpointTimer.current);
      checkpointTimer.current = setTimeout(() => { void checkpoint.current(); }, 1000);
    }
  }, [readOnly, onDirtyChange, recoveryKey]);

  const checkDocument = useCallback(() => {
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

  const getBuffer = useCallback(async () => {
    const serialize = async () => await editorRef.current?.save({ selective: false }) ?? null;
    const operation = serialization.current ? serialization.current.catch(() => null).then(serialize) : serialize();
    serialization.current = operation;
    try { return await operation; } finally { if (serialization.current === operation) serialization.current = null; }
  }, []);

  checkpoint.current = async () => {
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
      if (!recoveryFailed.current) toast.error("Draft recovery is unavailable. Save your document to keep changes.");
      recoveryFailed.current = true;
    }
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

  const save = useCallback((): Promise<boolean> => {
    if (pendingSave.current) return pendingSave.current;
    if (readOnly || !onSave) return Promise.resolve(false);
    checkDocument();
    const savingRevision = revision.current;
    const operation = (async () => {
      const buffer = await getBuffer();
      if (!buffer) return false;
      await onSave(buffer);
      if (recoveryKey) void keepDocxVersion(recoveryKey, buffer.slice(0)).catch(() => toast.error("Saved to workspace, but local version history is unavailable."));
      checkDocument();
      if (revision.current === savingRevision) {
        dirty.current = false;
        onDirtyChange?.(false);
        if (recoveryKey) await removeDocxRecovery(recoveryKey).catch(() => toast.error("Saved, but the old recovery copy could not be cleared."));
      }
      return true;
    })();
    pendingSave.current = operation.finally(() => { pendingSave.current = null; });
    return pendingSave.current;
  }, [readOnly, onSave, checkDocument, getBuffer, onDirtyChange, recoveryKey]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { save, getBuffer,
      executeAgentTool: async (toolName, args) => {
        if (readOnly) return { success: false, error: "This document is read-only." };
        if (!ready.current) return { success: false, error: "The document editor is not ready." };
        const isReviewDecision = REVIEW_TOOL_NAMES.has(toolName);
        let result: DocxEditorToolResult;
        if (isReviewDecision) {
          const changeIds = requestedChangeIds(args);
          if (!changeIds) {
            return { success: false, error: "changeIds must be a non-empty array of tracked-change IDs." };
          }
          result = decideTrackedChanges(
            editorRef.current,
            toolName === "accept_changes" ? "accept" : "reject",
            changeIds,
          );
        } else {
          result = executeToolCall(toolName, args);
        }
        if (!result.success) return result;
        const mutatesDocument = toolName === "suggest_change" || toolName === "add_comment" || isReviewDecision;
        if (!mutatesDocument) return result;
        markDirty();
        const saved = await save();
        if (!saved) return { success: false, error: "The document changed in the editor but could not be saved." };
        return { ...result, saved: true };
      },
    discardRecovery: () => {
      dirty.current = false;
      onDirtyChange?.(false);
      if (recoveryKey) void removeDocxRecovery(recoveryKey).catch(() => toast.error("The old recovery copy could not be cleared."));
    } };
    return () => { apiRef.current = null; };
  }, [apiRef, save, getBuffer, onDirtyChange, recoveryKey, executeToolCall, markDirty, readOnly]);

  useControlActions([
    {
      id: "document.read_draft", label: "Read the open document draft", sideEffect: "none",
      description: "Read the live DOCX, including unsaved edits, paragraph handles, comments and redlines. Use this instead of reading the older workspace file.",
      execute: async () => {
        const draftRevision = revision.current;
        const buffer = await getBuffer();
        if (!buffer) throw new Error("The document is still loading.");
        const draft = await DocxReviewer.fromBuffer(buffer);
        if (draftRevision !== revision.current) throw new Error("The draft changed while reading. Read it again before proposing changes.");
        return { name, documentId, draftRevision, text: draft.getContentAsText(), comments: draft.getComments(), changes: draft.getChanges() };
      },
    },
    {
      id: "document.propose_change", label: "Propose a change in the open document", sideEffect: "mutation", disabled: readOnly,
      description: "Apply a tracked proposal to the current draft. Requires name, documentId and draftRevision from document.read_draft. The lawyer reviews it with Accept/Reject; it is not saved automatically.",
      requiresArgs: true,
      args: [{ name: "name", type: "string", required: true }, { name: "documentId", type: "string", required: true }, { name: "draftRevision", type: "number", required: true }, { name: "paraId", type: "string", required: true }, { name: "search", type: "string", required: true }, { name: "replaceWith", type: "string", required: true }],
      execute: (args) => {
        if (readOnly) throw new Error("This document is read-only.");
        if (!args || typeof args !== "object" || !("name" in args) || args.name !== name ||
          !("documentId" in args) || args.documentId !== documentId ||
          !("draftRevision" in args) || args.draftRevision !== revision.current ||
          !("paraId" in args) || typeof args.paraId !== "string" ||
          !("search" in args) || typeof args.search !== "string" ||
          !("replaceWith" in args) || typeof args.replaceWith !== "string") throw new Error("Read the current draft again and supply its name, revision and paragraph handle.");
        const applied = editorRef.current?.proposeChange({ paraId: args.paraId, search: args.search, replaceWith: args.replaceWith, author: "LegalWork AI" });
        if (!applied) throw new Error("The target is missing, ambiguous or already redlined. Read the draft again.");
        markDirty();
        return { applied: true, saved: false, draftRevision: revision.current };
      },
    },
  ]);

  return (
    <div ref={containerRef} className="docx-host flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden" onClickCapture={onReviewClick} onKeyDownCapture={(event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s" || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (readOnly) return;
      void save().then((saved) => {
        if (!saved) toast.error("The document could not be saved. Your draft is still open.");
      }).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "The document could not be saved. Your draft is still open.");
      });
    }}>
      <div className="min-h-0 min-w-0 flex-1">
        <DocxEditor
          ref={editorRef}
          documentBuffer={documentBuffer}
          documentName={name}
          documentNameEditable={false}
          author={reviewer.trim() || "LegalWork"}
          readOnly={readOnly}
          mode={readOnly ? "viewing" : mode}
          onModeChange={setMode}
          commentsSidebarOpen={commentsOpen}
          onCommentsSidebarOpenChange={setCommentsOpen}
          onFontsLoaded={fitPage}
          colorMode={colorMode}
          showFileOpen={false}
          showHelpMenu
          showOutlineButton={false}
          showRuler={false}
          rulerUnit="cm"
          i18n={EDITOR_LABELS}
          className="h-full"
          onEditorViewReady={() => {
            // Initial import/normalization emits document and comment callbacks.
            // Establish the baseline after that first render, before accepting edits.
            requestAnimationFrame(() => {
              if (ready.current) return;
              lastDocument.current = editorRef.current?.getDocument() ?? null;
              ready.current = true;
              if (recovered) { dirty.current = true; onDirtyChange?.(true); }
            });
          }}
          onChange={(document) => { lastDocument.current = document; markDirty(); }}
          onCommentsChange={() => {
            // Loading the imported threads happens before the editor ref has a document.
            if (editorRef.current?.getDocument()) markDirty();
          }}
          onError={(error) => toast.error(error.message)}
        />
      </div>
    </div>
  );
}
