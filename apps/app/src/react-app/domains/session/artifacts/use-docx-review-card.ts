import { useCallback, useEffect, useRef, type MouseEvent, type RefObject } from "react";
import type { DocxEditorRef } from "@eigenpal/docx-editor-react";
import { extractTrackedChanges } from "@eigenpal/docx-editor-core/prosemirror/utils/extractTrackedChanges";

/** Keep the clicked native revision card open when Eigenpal's deferred caret
 * update lands outside the revision and collapses it again. Track revision IDs,
 * not card indexes, so accepting a different change cannot retarget the card. */
export function useDocxReviewCard(
  containerRef: RefObject<HTMLDivElement | null>,
  editorRef: RefObject<DocxEditorRef | null>,
) {
  const selectedRevision = useRef<number | null>(null);
  const repairing = useRef(false);
  const frame = useRef(0);

  const restoreCard = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const revisionId = selectedRevision.current;
      const host = containerRef.current;
      const view = editorRef.current?.getEditorRef()?.getView();
      if (revisionId === null || !host || !view) return;
      const index = extractTrackedChanges(view.state).entries.findIndex((entry) => (
        Number(entry.revisionId) === revisionId
        || Number(entry.insertionRevisionId) === revisionId
        || entry.coalescedRevisionIds?.some((id) => Number(id) === revisionId)
      ));
      if (index < 0) {
        selectedRevision.current = null;
        return;
      }
      const card = host.querySelectorAll<HTMLElement>(".docx-tracked-change-card")[index];
      if (!card || card.querySelector("button")) return;
      repairing.current = true;
      card.click();
      repairing.current = false;
    });
  }, [containerRef, editorRef]);

  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (repairing.current || !(event.target instanceof Element)) return;
    if (event.target.closest(".docx-unified-sidebar")) {
      // Native actions, card toggles and replies take over from the inline click.
      selectedRevision.current = null;
      return;
    }
    const mark = event.target.closest<HTMLElement>(".paged-editor__pages [data-revision-id]");
    const id = mark ? Number(mark.dataset.revisionId) : NaN;
    selectedRevision.current = Number.isInteger(id) ? id : null;
    if (selectedRevision.current !== null) restoreCard();
  }, [restoreCard]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const observer = new MutationObserver(() => {
      if (selectedRevision.current !== null) restoreCard();
    });
    observer.observe(host, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [containerRef, restoreCard]);

  return onClickCapture;
}
