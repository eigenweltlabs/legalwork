import { useCallback, useEffect, useRef, type MouseEvent, type RefObject } from "react";
import type { DocxEditorRef } from "@eigenpal/docx-editor-react";
import type { Node } from "prosemirror-model";
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
  const changes = useRef<{ doc: Node; entries: ReturnType<typeof extractTrackedChanges>["entries"] } | null>(null);

  const clearPosition = useCallback(() => {
    positioned.current?.removeAttribute("data-docx-review-anchor");
    positioned.current = null;
  }, []);

  const restoreCard = useCallback(() => {
    if (!selected.current || frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const anchor = selected.current;
      const host = containerRef.current;
      const view = editorRef.current?.getEditorRef()?.getView();
      if (!anchor || !host || !view) return;
      const { revisionId } = anchor;
      // Scrolling, zooming and expanding a card do not change the document.
      // Reuse its revisions instead of scanning the contract on every frame.
      if (changes.current?.doc !== view.state.doc) {
        changes.current = { doc: view.state.doc, entries: extractTrackedChanges(view.state).entries };
      }
      const index = changes.current.entries.findIndex((entry) => (
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
    const observer = new MutationObserver((records) => {
      if (selected.current && records.some(({ target }) => target instanceof Element && target.closest(".docx-unified-sidebar"))) restoreCard();
    });
    // Native card expansion changes its children. Ignore caret/position styles,
    // especially our own card styles, which used to schedule another frame.
    observer.observe(host, { childList: true, subtree: true });
    const zoom = new MutationObserver(restoreCard);
    zoom.observe(host, { attributes: true, attributeFilter: ["style"] });
    const resize = new ResizeObserver(restoreCard);
    resize.observe(host);
    host.addEventListener("painter:painted", restoreCard);
    host.addEventListener("transitionend", restoreCard);
    host.addEventListener("scroll", restoreCard, true);
    return () => {
      observer.disconnect();
      zoom.disconnect();
      resize.disconnect();
      host.removeEventListener("painter:painted", restoreCard);
      host.removeEventListener("transitionend", restoreCard);
      host.removeEventListener("scroll", restoreCard, true);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      clearPosition();
    };
  }, [containerRef, restoreCard, clearPosition]);

  return onClickCapture;
}
