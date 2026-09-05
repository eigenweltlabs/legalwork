/** @jsxImportSource react */
import { type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DocxEditor, type DocxEditorRef, type EditorMode } from "@eigenpal/docx-editor-react";
import "@eigenpal/docx-editor-react/styles.css";

import { getInitialThemeMode, subscribeToTheme, type ThemeMode } from "@/app/theme";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";

export type DocxEditorApi = {
  /** Serialize and persist the current document. Never clears edits made during a save. */
  save: () => Promise<boolean>;
  /** Serialize the live draft without writing to the workspace or clearing its dirty state. */
  getBuffer: () => Promise<ArrayBuffer | null>;
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
};

const AUTHOR_KEY = "legalwork.docx.reviewer";
// Eigenpal's File > Save exports a download, even when onSave is supplied.
// Name that action accurately; the panel Save button / Cmd+S persist to the workspace.
const EDITOR_LABELS = { toolbar: { save: "Download copy", saveShortcut: "" } };

function useThemeColorMode(): ThemeMode {
  return useSyncExternalStore(subscribeToTheme, getInitialThemeMode, getInitialThemeMode);
}

export function ArtifactDocxEditor({ name, content, author, readOnly = false, onSave, onDirtyChange, apiRef }: ArtifactDocxEditorProps) {
  const colorMode = useThemeColorMode();
  const [documentBuffer] = useState(() => content.slice(0));
  const [mode, setMode] = useState<EditorMode>("editing");
  const [reviewer, setReviewer] = useState(() => {
    if (author) return author;
    try { return window.localStorage.getItem(AUTHOR_KEY) ?? ""; } catch { return ""; }
  });
  const editorRef = useRef<DocxEditorRef>(null);
  const revision = useRef(0);
  const ready = useRef(false);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const lastDocument = useRef<ReturnType<DocxEditorRef["getDocument"]>>(null);

  const markDirty = useCallback(() => {
    if (readOnly || !ready.current) return;
    revision.current += 1;
    onDirtyChange?.(true);
  }, [readOnly, onDirtyChange]);

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
    return await editorRef.current?.save({ selective: false }) ?? null;
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
      checkDocument();
      if (revision.current === savingRevision) onDirtyChange?.(false);
      return true;
    })();
    pendingSave.current = operation.finally(() => { pendingSave.current = null; });
    return pendingSave.current;
  }, [readOnly, onSave, checkDocument, getBuffer, onDirtyChange]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { save, getBuffer };
    return () => { apiRef.current = null; };
  }, [apiRef, save, getBuffer]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden" onKeyDownCapture={(event) => {
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
      {!readOnly && <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-2">
          Reviewer
          <Input aria-label="Reviewer name" className="h-7 w-44 text-xs" placeholder="Your name" value={reviewer} onChange={(event) => {
            setReviewer(event.target.value);
            try { window.localStorage.setItem(AUTHOR_KEY, event.target.value); } catch { /* Device preference is optional. */ }
          }} />
        </label>
        <span>Used for new comments and tracked changes</span>
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
