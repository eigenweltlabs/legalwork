/** @jsxImportSource react */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { DocxEditor, type DocxEditorRef, type EditorMode } from "@eigenpal/docx-editor-react";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import "@eigenpal/docx-editor-react/styles.css";

import { getInitialThemeMode, subscribeToTheme, type ThemeMode } from "@/app/theme";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { keepDocxVersion, readDocxVersions, readDocxRecovery, removeDocxRecovery, writeDocxRecovery, type DocxRecovery, type DocxVersion } from "./docx-recovery";
import { createCleanDocx, downloadDocx } from "./docx-export";
import { useControlActions } from "../../../shell/control/control-provider";

export type DocxEditorApi = {
  /** Serialize and persist the current document. Never clears edits made during a save. */
  save: () => Promise<boolean>;
  /** Serialize the live draft without writing to the workspace or clearing its dirty state. */
  getBuffer: () => Promise<ArrayBuffer | null>;
  discardRecovery: () => void;
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
  const [focused, setFocused] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmClean, setConfirmClean] = useState(false);
  const [versions, setVersions] = useState<DocxVersion[] | null>(null);
  const [pendingVersion, setPendingVersion] = useState<DocxVersion | null>(null);
  const [comparison, setComparison] = useState<{ before: string; after: string } | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState("");
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(recovered);
  const checkpoint = useRef<() => Promise<void>>(async () => {});
  const checkpointed = useRef<{ revision: number; base: number | null } | null>(null);
  const [reviewer, setReviewer] = useState(() => {
    if (author) return author;
    try { return window.localStorage.getItem(AUTHOR_KEY) ?? ""; } catch { return ""; }
  });
  const editorRef = useRef<DocxEditorRef>(null);
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
      setRecoveryStatus("Keeping draft…");
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
      if (dirty.current && checkpointRevision === revision.current) setRecoveryStatus("Draft kept on this device");
    } catch { setRecoveryStatus("Recovery unavailable — save your document"); }
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
        setRecoveryStatus("");
        if (recoveryKey) await removeDocxRecovery(recoveryKey).catch(() => toast.error("Saved, but the old recovery copy could not be cleared."));
      }
      return true;
    })();
    pendingSave.current = operation.finally(() => { pendingSave.current = null; });
    return pendingSave.current;
  }, [readOnly, onSave, checkDocument, getBuffer, onDirtyChange, recoveryKey]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { save, getBuffer, discardRecovery: () => {
      dirty.current = false;
      onDirtyChange?.(false);
      if (recoveryKey) void removeDocxRecovery(recoveryKey).catch(() => toast.error("The old recovery copy could not be cleared."));
    } };
    return () => { apiRef.current = null; };
  }, [apiRef, save, getBuffer, onDirtyChange, recoveryKey]);

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
    <div className={focused ? "fixed inset-0 z-50 flex flex-col overflow-hidden bg-background" : "flex h-full min-h-0 w-full flex-col overflow-hidden"} onKeyDownCapture={(event) => {
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
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-3 py-2 text-xs text-muted-foreground">
      {!readOnly && <>
        <label className="flex items-center gap-2">
          Reviewer
          <Input aria-label="Reviewer name" className="h-7 w-44 text-xs" placeholder="Your name" value={reviewer} onChange={(event) => {
            setReviewer(event.target.value);
            try { window.localStorage.setItem(AUTHOR_KEY, event.target.value); } catch { /* Device preference is optional. */ }
          }} />
        </label>
        <span role="status">{recoveryStatus || "Used for new comments and tracked changes"}</span>
      </>}
        <div className="ml-auto flex gap-2">
          {recoveryKey && <Button size="sm" variant="ghost" onClick={() => {
            if (versions) { setVersions(null); setComparison(null); return; }
            void readDocxVersions(recoveryKey).then(setVersions).catch(() => toast.error("Could not read local version history."));
          }}>Version history</Button>}
          <Button size="sm" variant="ghost" disabled={exporting} onClick={() => setConfirmClean(true)}>{exporting ? "Preparing copy…" : "Download clean copy"}</Button>
          <Button size="sm" variant="ghost" onClick={() => editorRef.current?.openPrintPreview()}>Print / PDF</Button>
          {focused && !readOnly && <Button size="sm" onClick={() => {
            void save().then((saved) => saved ? toast.success("Saved") : toast.error("The document is still loading. Try again shortly.")).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not save your draft."));
          }}>Save</Button>}
          <Button size="sm" variant="outline" onClick={() => setFocused(!focused)}>{focused ? "Return to chat" : "Focus document"}</Button>
        </div>
      </div>
      {confirmClean && <div className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-muted/40 px-3 py-2 text-sm">
        <p>Accept all tracked changes and remove comments in the downloaded copy. Your working draft keeps its markup.</p>
        <Button size="sm" disabled={exporting} onClick={() => {
          setExporting(true);
          void getBuffer().then(async (buffer) => {
            if (!buffer) throw new Error("The document is still loading.");
            downloadDocx(await createCleanDocx(buffer), name.replace(/\.docx$/i, "") + "-clean.docx");
            setConfirmClean(false);
          }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not create a clean copy.")).finally(() => setExporting(false));
        }}>Create clean copy</Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmClean(false)}>Cancel export</Button>
      </div>}
      {versions && <div className="max-h-[45vh] shrink-0 overflow-auto border-b p-3 text-sm">
        <p className="mb-2 text-muted-foreground">Last five saves on this device. Workspace saves remain the authoritative file.</p>
        {!versions.length && <p>No saved versions yet.</p>}
        {versions.map((version) => <div key={version.savedAt} className="flex items-center gap-2 py-1">
          <span>{new Date(version.savedAt).toLocaleString()}</span>
          <Button size="sm" variant="ghost" onClick={() => downloadDocx(version.buffer, name.replace(/\.docx$/i, "") + `-${version.savedAt}.docx`)}>Download version</Button>
          <Button size="sm" variant="ghost" onClick={() => {
            void getBuffer().then(async (current) => {
              if (!current) throw new Error("Document is still loading.");
              const [before, after] = await Promise.all([DocxReviewer.fromBuffer(version.buffer), DocxReviewer.fromBuffer(current)]);
              setComparison({ before: before.getContentAsText(), after: after.getContentAsText() });
            }).catch(() => toast.error("Could not compare these documents."));
          }}>Compare text</Button>
          {!readOnly && <Button size="sm" variant="ghost" onClick={() => setPendingVersion(version)}>Restore as draft</Button>}
        </div>)}
        {pendingVersion && !readOnly && <div className="my-2 space-y-2 rounded-md border p-3">
          <p>Replace the open draft with the version from {new Date(pendingVersion.savedAt).toLocaleString()}? Save or download current edits first. The workspace file will not change until you save.</p>
          <Button size="sm" onClick={() => {
            void editorRef.current?.loadDocumentBuffer(pendingVersion.buffer.slice(0)).then(() => { markDirty(); setVersions(null); setComparison(null); setPendingVersion(null); }).catch(() => toast.error("Could not restore this version."));
          }}>Restore selected version</Button>
          <Button size="sm" variant="ghost" onClick={() => setPendingVersion(null)}>Cancel restore</Button>
        </div>}
        {comparison && <><p className="my-2">Text comparison only; formatting, numbering and layout are not compared.</p><div className="grid grid-cols-2 gap-4"><div><h4>Saved version</h4><pre className="whitespace-pre-wrap text-xs">{comparison.before}</pre></div><div><h4>Current draft</h4><pre className="whitespace-pre-wrap text-xs">{comparison.after}</pre></div></div></>}
      </div>}
      <div className="min-h-0 flex-1">
        <DocxEditor
          ref={editorRef}
          documentBuffer={documentBuffer}
          documentName={name}
          documentNameEditable={false}
          author={reviewer.trim() || "LegalWork"}
          readOnly={readOnly}
          mode={readOnly ? "viewing" : mode}
          onModeChange={setMode}
          colorMode={colorMode}
          showFileOpen={false}
          showHelpMenu
          showOutlineButton
          showRuler
          rulerUnit="cm"
          i18n={EDITOR_LABELS}
          className="h-full"
          onEditorViewReady={() => {
            // Initial import/normalization emits document and comment callbacks.
            // Establish the baseline after that first render, before accepting edits.
            requestAnimationFrame(() => {
              lastDocument.current = editorRef.current?.getDocument() ?? null;
              ready.current = true;
              if (recovered) { dirty.current = true; onDirtyChange?.(true); setRecoveryStatus("Recovered draft — save to keep changes in the workspace"); }
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
