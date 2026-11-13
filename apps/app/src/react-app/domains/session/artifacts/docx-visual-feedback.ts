import { renderToCanvas } from "pptx-react-viewer";
import { renderAllPagesNow } from "@eigenpal/docx-editor-core/layout-painter";
import type { Node } from "prosemirror-model";
import type { Layout } from "@eigenpal/docx-editor-core/layout-engine";
import { wordWritingLocations } from "./docx-agent-locations";

/** Capture the live page without selecting, navigating, saving or changing it.
 * Labels are painted onto the exported canvas, never onto the user's document. */
export async function wordPagePreview(host: HTMLElement | null, doc: Node, layout: Layout | null, pageNumber: number, annotate: boolean) {
  const pages = host?.querySelector<HTMLElement>(".paged-editor__pages");
  const page = layout?.pages.find(page => page.number === pageNumber);
  if (!pages || !page) throw new Error(`Page ${pageNumber} is not ready. Read the live layout before requesting its preview.`);
  renderAllPagesNow(pages);
  const element = Array.from(pages.querySelectorAll<HTMLElement>(".layout-page")).find(element => Number(element.dataset.pageNumber) === pageNumber);
  if (!element?.offsetWidth || !element.offsetHeight) throw new Error("The requested page is not rendered. Visual inspection is unavailable.");
  await document.fonts.ready;
  const canvas = await renderToCanvas(element, {
    width: element.offsetWidth, height: element.offsetHeight,
    scale: Math.min(1.5, 1600 / Math.max(element.offsetWidth, element.offsetHeight)),
    backgroundColor: "#ffffff", useCORS: true, allowTaint: false, logging: false,
    onclone: (_document, clone) => {
      // html2canvas measures character positions in the cloned DOM but paints
      // fonts at 100%. Retaining editor zoom makes those positions too close.
      for (let parent: HTMLElement | null = clone; parent; parent = parent.parentElement) {
        parent.style.transform = "none";
        parent.style.zoom = "1";
      }
    },
  });
  const labels: { label: string; x: number; y: number; width: number; height: number }[] = [];
  if (annotate) {
    labels.push({ label: "MAIN TEXT FLOW", x: page.margins.left, y: page.margins.top, width: page.size.w - page.margins.left - page.margins.right, height: page.size.h - page.margins.top - page.margins.bottom });
    labels.push({ label: "HEADER", x: 2, y: 2, width: page.size.w - 4, height: Math.max(18, page.margins.top - 4) });
    labels.push({ label: "FOOTER", x: 2, y: page.size.h - page.margins.bottom, width: page.size.w - 4, height: Math.max(18, page.margins.bottom - 2) });
    const rect = element.getBoundingClientRect();
    const scale = element.offsetWidth / rect.width;
    const items = wordWritingLocations(doc, layout);
    for (const paragraph of element.querySelectorAll<HTMLElement>(".layout-paragraph[data-pm-start]")) {
      if (paragraph.closest(".layout-page-header, .layout-page-footer, .layout-footnote-area")) continue;
      const pos = Number(paragraph.dataset.pmStart);
      const item = items.find(item => item.pos === pos || item.pos + 1 === pos);
      if (!item) continue;
      const bounds = paragraph.getBoundingClientRect();
      labels.push({ label: `${item.location.area}: ${item.paraId}`, x: (bounds.left - rect.left) * scale, y: (bounds.top - rect.top) * scale, width: bounds.width * scale, height: Math.max(12, bounds.height * scale) });
    }
    for (const note of element.querySelectorAll<HTMLElement>(".layout-footnote-content")) {
      const bounds = note.getBoundingClientRect();
      labels.push({ label: `FOOTNOTE ${note.dataset.wordNoteId ?? ""}`, x: (bounds.left - rect.left) * scale, y: (bounds.top - rect.top) * scale, width: bounds.width * scale, height: bounds.height * scale });
    }
    const context = canvas.getContext("2d");
    if (context) {
      // The DOM rasterizer leaves its own scale and page translation on the context.
      // Replace that transform so labels use page-local coordinates.
      context.setTransform(canvas.width / element.offsetWidth, 0, 0, canvas.height / element.offsetHeight, 0, 0);
      context.font = "10px sans-serif"; context.lineWidth = 1;
      for (const label of labels) {
        context.strokeStyle = label.label.startsWith("main:") || label.label === "MAIN TEXT FLOW" ? "#027a8a" : "#9d4510";
        context.strokeRect(label.x, label.y, label.width, label.height);
        const width = context.measureText(label.label).width + 6;
        const y = Math.max(11, label.y);
        context.fillStyle = "#ffffff"; context.fillRect(label.x, y - 11, width, 12);
        context.fillStyle = context.strokeStyle; context.fillText(label.label, label.x + 3, y - 1);
      }
    }
  }
  return { page: pageNumber, totalPages: layout!.pages.length, labels, preview: { available: true, mime: "image/png", width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL("image/png") }, guidance: "This is the live editor's rendering. Labels identify writing areas; use the matching paragraph handle and area from a fresh read to edit. Page headers may contain artwork spanning the body. Do not infer a writing target from visual proximity alone." };
}
