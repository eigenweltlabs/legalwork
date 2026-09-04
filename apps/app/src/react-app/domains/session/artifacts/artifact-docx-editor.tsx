/** @jsxImportSource react */
import { type MouseEvent as ReactMouseEvent, type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DocxEditor, type DocxEditorRef } from "@eigenpal/docx-editor-react";
import { useDocxAgentTools } from "@eigenpal/docx-editor-agents/react";
import { acceptChangeById, rejectChangeById } from "@eigenpal/docx-editor-core/prosemirror/commands";
import { extractTrackedChanges } from "@eigenpal/docx-editor-core/prosemirror/utils/extractTrackedChanges";
import "@eigenpal/docx-editor-react/styles.css";

import { getInitialThemeMode, subscribeToTheme, type ThemeMode } from "@/app/theme";

export type DocxEditorApi = {
  /** Serialize the current document and persist it via `onSave`. Returns true on write. */
  save: () => Promise<boolean>;
  /** Run one of the editor's live agent tools and persist successful mutations. */
  executeAgentTool: (toolName: string, args: Record<string, unknown>) => Promise<DocxEditorToolResult>;
};

export type DocxEditorToolResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  saved?: boolean;
};

type ArtifactDocxEditorProps = {
  name: string;
  /** Initial .docx bytes. Live editor mutations are saved without reloading these bytes. */
  content: ArrayBuffer;
  /** Author name stamped on comments and tracked changes. */
  author?: string;
  /** Read-only (remote workspaces / non-file targets): renders in Word-style viewing mode. */
  readOnly?: boolean;
  /** Persists serialized .docx bytes to the workspace. */
  onSave?: (buffer: ArrayBuffer) => void | Promise<void>;
  /** The panel sets this so its header "Save" button can drive the editor. */
  apiRef?: RefObject<DocxEditorApi | null>;
};

type StickyNativeCard =
  | { kind: "tracked"; index: number }
  | { kind: "comment"; id: number }
  | { kind: "pending" };

// US-Letter page width in CSS px at 100% (8.5in × 96dpi). Fallback before the real
// page (A4/Letter/custom) can be measured.
const FALLBACK_PAGE_WIDTH = 816;
// Visible breathing room on each side of the page; the zoom-to-fit shrinks the page
// by 2× this so it sits centered inside the panel with that gutter.
const PAGE_GUTTER = 12;
const PAGE_MARGIN = PAGE_GUTTER * 2;

// The editor's pages-track has a hard `min-width` (≈944px, the document's design width),
// so in the narrow artifact panel it overflows and the page sits off-center with a
// horizontal scrollbar. Collapse the track to the panel width and center the page.
// Target both the React (`docx-editor__scroll-container`) and Vue
// (`docx-editor-vue__pages-viewport`) class names so this always lands.
const DOCX_FIT_CSS = `
.ep-root .docx-editor__scroll-container,
.ep-root .docx-editor-vue__pages-viewport { overflow-x: hidden !important; }
.ep-root .docx-editor__scroll-container > *,
.ep-root .docx-editor-vue__pages-viewport > * {
  min-width: 0 !important;
  max-width: 100% !important;
  width: 100% !important;
  box-sizing: border-box !important;
  justify-content: center !important;
}
/* Every wrapper between the scroll container and the actual page (.layout-page) must
   span the full width, and the page itself must center — otherwise an inner wrapper is
   pinned narrow and the page is pushed left / clipped. */
.ep-root .docx-editor__scroll-container :has(.layout-page) {
  min-width: 0 !important;
  max-width: 100% !important;
  width: 100% !important;
}
.ep-root .paged-editor__pages { align-items: center !important; justify-content: center !important; }
/* The zoom is a CSS scale and the editor's own centering is off for redline layouts, so
   the page ends up shifted. We measure the real offset in JS and correct it with this
   variable (set on our container, inherited here). The important flag survives re-renders. */
.ep-root .layout-page {
  margin-left: auto !important;
  margin-right: auto !important;
  transform: translateX(var(--docx-center-x, 0px)) !important;
}
/* Keep Eigenpal's native review/comment cards, but anchor their shared sidebar to the
   visible editor edge. Its page-relative left calculation can otherwise place the
   340px rail beyond the clipped artifact panel. */
.docx-host { container-type: inline-size; }
.docx-host .docx-unified-sidebar > div,
.docx-host .docx-tracked-change-card,
.docx-host .docx-comment-card {
  box-sizing: border-box !important;
  max-width: 100% !important;
}
/* When the page and the 340px rail cannot fit side-by-side, retain Eigenpal's native
   card but show only the selected/expanded item. Clicking an inline redline or comment
   expands that item; the inactive stack no longer obscures the document. */
@container (max-width: 1199px) {
  .docx-host .docx-unified-sidebar {
    left: auto !important;
    right: 12px !important;
    width: min(340px, calc(100% - 24px)) !important;
    max-width: calc(100% - 24px) !important;
  }
  .docx-host .docx-unified-sidebar > div > div:has(.docx-tracked-change-card),
  .docx-host .docx-unified-sidebar > div > div:has(.docx-comment-card) {
    display: none !important;
  }
  .docx-host .docx-unified-sidebar > div > div:has(.docx-tracked-change-card button),
  .docx-host .docx-unified-sidebar > div > div:has(.docx-comment-card button),
  .docx-host .docx-unified-sidebar > div > div:has(.docx-tracked-change-card input),
  .docx-host .docx-unified-sidebar > div > div:has(.docx-comment-card textarea) {
    display: block !important;
  }
}
`;

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

/**
 * In-artifact DOCX viewer/editor backed by @eigenpal/docx-editor-react (Apache-2.0).
 * Renders the real OOXML package (pagination, tables, tracked changes), scales the
 * page to the panel width, and persists edits through the panel's Save button.
 */
export function ArtifactDocxEditor({ name, content, author = "LegalWork", readOnly = false, onSave, apiRef }: ArtifactDocxEditorProps) {
  const colorMode = useThemeColorMode();
  // Capture a private copy of the bytes once: the editor may detach the buffer while
  // parsing, and saving a live edit must not reload the document or reset its viewport.
  // The parent only remounts this component when the selected artifact itself changes.
  const [documentBuffer] = useState(() => content.slice(0));
  // Default the comments column CLOSED so a redline doc gets the full panel width (the
  // open column was squeezing the page). Still toggleable; the fit re-runs when it opens.
  const [commentsSidebarOpen, setCommentsSidebarOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<DocxEditorRef>(null);
  const stickyNativeCardRef = useRef<StickyNativeCard | null>(null);
  const repairNativeCardAfterRef = useRef(0);
  const { executeToolCall } = useDocxAgentTools({ editorRef, author });

  const nativeCardForSelection = useCallback((selection: StickyNativeCard) => {
    const container = containerRef.current;
    if (!container || selection.kind === "pending") return null;
    if (selection.kind === "comment") {
      return container.querySelector<HTMLElement>(`.docx-comment-card[data-comment-id="${selection.id}"]`);
    }
    return container.querySelectorAll<HTMLElement>(".docx-tracked-change-card")[selection.index] ?? null;
  }, []);

  const repairNativeCard = useCallback(() => {
    if (performance.now() < repairNativeCardAfterRef.current) return;
    const selection = stickyNativeCardRef.current;
    const container = containerRef.current;
    if (!selection || !container) return;
    if (selection.kind === "pending") {
      const expandedComment = [...container.querySelectorAll<HTMLElement>(".docx-comment-card")]
        .find((card) => card.querySelector("button"));
      const id = Number(expandedComment?.dataset.commentId);
      if (Number.isInteger(id)) stickyNativeCardRef.current = { kind: "comment", id };
      return;
    }
    const card = nativeCardForSelection(selection);
    if (!card) return;
    if (!card.querySelector("button")) card.click();
  }, [nativeCardForSelection]);

  const rememberNativeCard = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const sidebar = event.target.closest(".docx-unified-sidebar");
    if (sidebar) {
      if (event.target.closest("button")) stickyNativeCardRef.current = null;
      else if (!event.target.closest("input, textarea")) {
        const commentCard = event.target.closest<HTMLElement>(".docx-comment-card");
        if (commentCard) {
          const id = Number(commentCard.dataset.commentId);
          stickyNativeCardRef.current = commentCard.querySelector("button")
            ? null
            : Number.isInteger(id) ? { kind: "comment", id } : null;
        } else {
          const trackedCard = event.target.closest<HTMLElement>(".docx-tracked-change-card");
          const cards = containerRef.current?.querySelectorAll<HTMLElement>(".docx-tracked-change-card");
          const index = trackedCard && cards ? [...cards].indexOf(trackedCard) : -1;
          stickyNativeCardRef.current = trackedCard?.querySelector("button")
            ? null
            : index >= 0 ? { kind: "tracked", index } : null;
        }
      }
      return;
    }

    const revision = event.target.closest<HTMLElement>(".paged-editor__pages [data-revision-id]");
    if (revision) {
      const revisionId = Number(revision.dataset.revisionId);
      const view = editorRef.current?.getEditorRef()?.getView();
      const entries = view ? extractTrackedChanges(view.state).entries : [];
      const index = entries.findIndex((entry) => (
        Number(entry.revisionId) === revisionId
        || Number(entry.insertionRevisionId) === revisionId
        || entry.coalescedRevisionIds?.some((id) => Number(id) === revisionId)
      ));
      stickyNativeCardRef.current = index >= 0 ? { kind: "tracked", index } : null;
      repairNativeCardAfterRef.current = performance.now() + 500;
      window.setTimeout(repairNativeCard, 550);
      return;
    }

    if (event.target.closest(".docx-comment-margin-markers, .paged-editor__pages [data-comment-id]")) {
      stickyNativeCardRef.current = { kind: "pending" };
      repairNativeCardAfterRef.current = performance.now() + 500;
      window.setTimeout(repairNativeCard, 550);
      return;
    }
    stickyNativeCardRef.current = null;
  }, [repairNativeCard]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => repairNativeCard());
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [repairNativeCard]);

  const pagesViewport = () =>
    containerRef.current?.querySelector(
      ".docx-editor__scroll-container, .docx-editor-vue__pages-viewport",
    ) as HTMLElement | null;

  const fitToWidth = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Measure the actual PAGES viewport, not the whole editor: a redline doc shows a
    // comments column on the right that eats horizontal space. Using the viewport width
    // makes the page fit what's actually left for it. Fall back to the wrapper width.
    const viewport = pagesViewport();
    const areaWidth = viewport?.clientWidth ?? containerRef.current?.clientWidth ?? 0;
    const available = areaWidth - PAGE_MARGIN;
    if (available <= 0) return;

    const zoom = editor.getZoom() || 1;
    // Measure the real page element (.layout-page) and divide out the zoom to get its
    // true width (A4/Letter/custom). This is the one reliable page node — not the track
    // and not a table cell. Fall back to Letter width if it isn't rendered yet.
    let naturalWidth = FALLBACK_PAGE_WIDTH;
    const page = containerRef.current?.querySelector(".layout-page") as HTMLElement | null;
    if (page) {
      const measured = page.getBoundingClientRect().width / zoom;
      if (measured > 200) naturalWidth = measured;
    }

    const target = Math.max(0.2, Math.min(1, available / naturalWidth));
    if (Math.abs(target - zoom) > 0.005) editor.setZoom(target);
  }, []);

  // Measure the page's real left/right gap and correct the horizontal offset via a CSS
  // variable (the editor's own centering is off for redline layouts). Reset to 0 first so
  // we measure the true position, not the previously-corrected one.
  const centerPage = useCallback(() => {
    const container = containerRef.current;
    const sc = pagesViewport();
    const page = container?.querySelector(".layout-page") as HTMLElement | null;
    const editor = editorRef.current;
    if (!container || !sc || !page || !editor) return;
    container.style.setProperty("--docx-center-x", "0px");
    const scR = sc.getBoundingClientRect();
    const pr = page.getBoundingClientRect();
    const correction = ((scR.right - pr.right) - (pr.left - scR.left)) / 2;
    const zoom = editor.getZoom() || 1; // .layout-page is scaled by the zoom ancestor
    container.style.setProperty("--docx-center-x", Math.abs(correction) > 1.5 ? `${correction / zoom}px` : "0px");
  }, []);

  const applyFit = useCallback(() => {
    fitToWidth();
    requestAnimationFrame(centerPage);
  }, [fitToWidth, centerPage]);

  // Re-fit on resize of the panel AND the pages viewport (it shrinks when the comments
  // column opens), plus a few times on mount to catch late layout.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(applyFit);
    });
    observer.observe(container);
    let tries = 0;
    const attachViewport = () => {
      const viewport = pagesViewport();
      if (viewport) {
        observer.observe(viewport);
        applyFit();
      } else if (tries++ < 25) {
        window.setTimeout(attachViewport, 150);
      }
    };
    attachViewport();
    const timers = [150, 450, 900, 1500].map((ms) => window.setTimeout(applyFit, ms));
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [applyFit]);

  const persist = useCallback(async () => {
    const buffer = await editorRef.current?.save({ selective: false });
    if (!buffer || !onSave) return false;
    await onSave(buffer);
    return true;
  }, [onSave]);

  // Expose an explicit save to the panel header. `save()` returns the serialized bytes,
  // which we persist directly (not relying on the editor's internal onSave wiring).
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      save: persist,
      executeAgentTool: async (toolName, args) => {
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
        const saved = await persist();
        if (!saved) return { success: false, error: "The document changed in the editor but could not be saved." };
        return { ...result, saved: true };
      },
    };
    return () => {
      if (apiRef.current) apiRef.current = null;
    };
  }, [apiRef, executeToolCall, persist]);

  return (
    <div
      ref={containerRef}
      className="docx-host relative h-full min-h-0 w-full overflow-hidden"
      onClickCapture={rememberNativeCard}
    >
      <style>{DOCX_FIT_CSS}</style>
      <DocxEditor
        ref={editorRef}
        documentBuffer={documentBuffer}
        documentName={name}
        documentNameEditable={false}
        author={author}
        mode={readOnly ? "viewing" : "suggesting"}
        colorMode={colorMode}
        showFileOpen={false}
        showHelpMenu={false}
        showOutlineButton={false}
        commentsSidebarOpen={commentsSidebarOpen}
        onCommentsSidebarOpenChange={setCommentsSidebarOpen}
        className="h-full"
        onFontsLoaded={applyFit}
      />
    </div>
  );
}
