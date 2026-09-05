import { useCallback, useEffect, useRef, type MouseEvent, type RefObject } from "react";
import type { DocxEditorRef } from "@eigenpal/docx-editor-react";
import { extractTrackedChanges } from "@eigenpal/docx-editor-core/prosemirror/utils/extractTrackedChanges";
import { positionDocxReviewCard } from "./docx-review-card-position";

type ReviewAnchor = { revisionId: number; occurrence: number; fragment: number; keepOpen: boolean };

/** Keep the clicked native revision card open when Eigenpal's deferred caret
 * update lands outside the revision and collapses it again. Track revision IDs,
 * not card indexes, so accepting a different change cannot retarget the card. */
export function useDocxReviewCard(
  containerRef: RefObject<HTMLDivElement | null>,
  editorRef: RefObject<DocxEditorRef | null>,
) {
  const selected = useRef<ReviewAnchor | null>(null);
  const positioned = useRef<HTMLElement | null>(null);
  const repairing = useRef(false);
  const frame = useRef(0);

  const clearPosition = useCallback(() => {
    positioned.current?.removeAttribute("data-docx-review-anchor");
    positioned.current = null;
  }, []);

  const restoreCard = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const anchor = selected.current;
      const host = containerRef.current;
      const view = editorRef.current?.getEditorRef()?.getView();
      if (!anchor || !host || !view) return;
      const { revisionId } = anchor;
      const index = extractTrackedChanges(view.state).entries.findIndex((entry) => (
        Number(entry.revisionId) === revisionId
        || Number(entry.insertionRevisionId) === revisionId
        || entry.coalescedRevisionIds?.some((id) => Number(id) === revisionId)
      ));
      if (index < 0) {
        selected.current = null;
        clearPosition();
        return;
      }
      const card = host.querySelectorAll<HTMLElement>(".docx-tracked-change-card")[index];
      if (!card) return;
      if (!card.querySelector("button")) {
        clearPosition();
        if (anchor.keepOpen) {
          repairing.current = true;
          card.click();
          repairing.current = false;
        } else selected.current = null;
        return;
      }
      const marks = host.querySelectorAll<HTMLElement>(`.paged-editor__pages [data-revision-id="${revisionId}"]`);
      const mark = marks[Math.min(anchor.occurrence, marks.length - 1)];
      const wrapper = card.parentElement;
      if (!mark || !wrapper) { clearPosition(); return; }
      if (positioned.current !== wrapper) clearPosition();
      positioned.current = wrapper;
      positionDocxReviewCard(host, wrapper, mark, anchor.fragment);
    });
  }, [containerRef, editorRef, clearPosition]);

  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (repairing.current || !(event.target instanceof Element)) return;
    if (event.target.closest(".docx-unified-sidebar")) {
      // Keep the anchor while replying; let native actions/toggles close the card.
      if (selected.current) selected.current.keepOpen = false;
      restoreCard();
      return;
    }
    const mark = event.target.closest<HTMLElement>(".paged-editor__pages [data-revision-id]");
    const id = mark ? Number(mark.dataset.revisionId) : NaN;
    clearPosition();
    selected.current = null;
    if (mark && Number.isInteger(id)) {
      const marks = event.currentTarget.querySelectorAll(`.paged-editor__pages [data-revision-id="${id}"]`);
      const fragment = [...mark.getClientRects()].findIndex((rect) => event.clientY >= rect.top && event.clientY <= rect.bottom);
      selected.current = { revisionId: id, occurrence: [...marks].indexOf(mark), fragment: Math.max(0, fragment), keepOpen: true };
      restoreCard();
    }
  }, [restoreCard, clearPosition]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const observer = new MutationObserver(() => {
      if (selected.current) restoreCard();
    });
    observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    const resize = new ResizeObserver(restoreCard);
    resize.observe(host);
    host.addEventListener("scroll", restoreCard, true);
    return () => {
      observer.disconnect();
      resize.disconnect();
      host.removeEventListener("scroll", restoreCard, true);
      cancelAnimationFrame(frame.current);
      clearPosition();
    };
  }, [containerRef, restoreCard, clearPosition]);

  return onClickCapture;
}
