import { useCallback, useLayoutEffect, type RefObject } from "react";
import type { DocxEditorRef } from "@eigenpal/docx-editor-react";

const PAGE_GUTTERS = 48;
const REVIEW_RAIL = 352;

/** Fit on layout changes; the native zoom controls remain usable between resizes. */
export function useDocxPageFit(
  containerRef: RefObject<HTMLDivElement | null>,
  editorRef: RefObject<DocxEditorRef | null>,
  commentsOpen: boolean,
) {
  const fitPage = useCallback(() => {
    const host = containerRef.current;
    const editor = editorRef.current;
    const page = host?.querySelector<HTMLElement>(".layout-page");
    const viewport = host?.querySelector<HTMLElement>(".docx-editor__scroll-container");
    if (!host || !editor || !page || !viewport || !page.offsetWidth) return;
    const rail = viewport.clientWidth >= 900 && host.querySelector(".docx-unified-sidebar") ? REVIEW_RAIL : 0;
    const available = viewport.clientWidth - PAGE_GUTTERS - rail;
    const zoom = Math.max(0.25, Math.min(1, available / page.offsetWidth));
    if (Math.abs(editor.getZoom() - zoom) > 0.005) editor.setZoom(zoom);
  }, [containerRef, editorRef, commentsOpen]);

  useLayoutEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    let frame = 0;
    let page: HTMLElement | null = null;
    let lastHostWidth = 0;
    let lastPageWidth = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitPage);
    };
    const onResize = () => {
      const width = page?.offsetWidth ?? 0;
      if (host.clientWidth === lastHostWidth && width === lastPageWidth) return;
      lastHostWidth = host.clientWidth;
      lastPageWidth = width;
      scheduleFit();
    };
    const resize = new ResizeObserver(onResize);
    resize.observe(host);
    const attachPage = () => {
      // Mirror native toolbar/trackpad zoom without forcing another fit.
      const zoom = editorRef.current?.getZoom() ?? 1;
      if (host.style.getPropertyValue("--docx-zoom") !== String(zoom)) host.style.setProperty("--docx-zoom", String(zoom));
      const next = host.querySelector<HTMLElement>(".layout-page");
      if (next) {
        const rail = host.clientWidth >= 900 && host.querySelector(".docx-unified-sidebar") ? REVIEW_RAIL : 0;
        const minWidth = `${next.offsetWidth * zoom + PAGE_GUTTERS + rail}px`;
        if (host.style.getPropertyValue("--docx-layout-width") !== minWidth) host.style.setProperty("--docx-layout-width", minWidth);
      }
      if (next === page) return;
      if (page) resize.unobserve(page);
      page = next;
      if (page) resize.observe(page);
      onResize();
    };
    const mutations = new MutationObserver(attachPage);
    mutations.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    attachPage();
    scheduleFit();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [containerRef, editorRef, fitPage]);

  return fitPage;
}
