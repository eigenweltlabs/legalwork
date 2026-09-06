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
    let viewport: HTMLElement | null = null;
    let zoomLayer: HTMLElement | null = null;
    let sidebar: Element | null = null;
    let lastHostWidth = 0;
    let lastViewportWidth = 0;
    let lastPageWidth = 0;
    let transform = "";
    let needsFit = true;

    const schedule = (fit = false) => {
      needsFit ||= fit;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        attachLayout();
        if (needsFit) { needsFit = false; fitPage(); }
        const zoom = editorRef.current?.getZoom() ?? 1;
        const rail = host.clientWidth >= 900 && sidebar ? REVIEW_RAIL : 0;
        const width = page?.offsetWidth ?? 0;
        if (host.style.getPropertyValue("--docx-zoom") !== String(zoom)) host.style.setProperty("--docx-zoom", String(zoom));
        const minWidth = `${width * zoom + PAGE_GUTTERS + rail}px`;
        if (width && host.style.getPropertyValue("--docx-layout-width") !== minWidth) host.style.setProperty("--docx-layout-width", minWidth);
      });
    };
    const resize = new ResizeObserver(() => {
      const width = page?.offsetWidth ?? 0;
      const viewportWidth = viewport?.clientWidth ?? 0;
      if (host.clientWidth === lastHostWidth && width === lastPageWidth && viewportWidth === lastViewportWidth) return;
      lastHostWidth = host.clientWidth;
      lastViewportWidth = viewportWidth;
      lastPageWidth = width;
      schedule(true);
    });
    const structure = new MutationObserver(() => schedule());
    const zoomChanges = new MutationObserver(() => {
      const next = zoomLayer?.style.transform ?? "";
      if (next === transform) return;
      transform = next;
      schedule();
    });
    const attachLayout = () => {
      const nextPage = host.querySelector<HTMLElement>(".layout-page");
      const nextViewport = host.querySelector<HTMLElement>(".docx-editor__scroll-container");
      const nextZoomLayer = host.querySelector(".paged-editor__pages")?.parentElement ?? null;
      const nextSidebar = host.querySelector(".docx-unified-sidebar");
      if (nextPage === page && nextViewport === viewport && nextZoomLayer === zoomLayer && nextSidebar === sidebar) return;
      if (nextSidebar !== sidebar) needsFit = true;
      if (page) resize.unobserve(page);
      if (viewport) resize.unobserve(viewport);
      page = nextPage;
      viewport = nextViewport;
      zoomLayer = nextZoomLayer;
      sidebar = nextSidebar;
      if (page) resize.observe(page);
      if (viewport) resize.observe(viewport);
      // Observe only the layout ancestors. Paragraph/text mutations and caret
      // styles never schedule geometry work on the typing path.
      structure.disconnect();
      structure.observe(host, { childList: true, subtree: !page });
      for (const element of [page, viewport, zoomLayer, sidebar]) {
        for (let parent = element?.parentElement; parent && parent !== host; parent = parent.parentElement) {
          structure.observe(parent, { childList: true });
        }
      }
      zoomChanges.disconnect();
      if (zoomLayer) {
        transform = zoomLayer.style.transform;
        zoomChanges.observe(zoomLayer, { attributes: true, attributeFilter: ["style"] });
      }
    };
    // Painter events bubble from the pages container. Later paints need no
    // work unless the painter replaced the observed first page.
    const onPaint = () => { if (!page?.isConnected) schedule(); };
    resize.observe(host);
    // Observe the loading subtree only until the first page is available.
    structure.observe(host, { childList: true, subtree: true });
    host.addEventListener("painter:painted", onPaint);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      structure.disconnect();
      zoomChanges.disconnect();
      host.removeEventListener("painter:painted", onPaint);
    };
  }, [containerRef, editorRef, fitPage]);

  return fitPage;
}
