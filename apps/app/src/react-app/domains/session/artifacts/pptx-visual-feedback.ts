import { renderToCanvas } from "pptx-react-viewer";

/** Check the rendered text, including wrapping and inherited fonts, rather than
 * assuming that a successful text replacement still fits the template. */
export function inspectSlideTextLayout(stage: HTMLElement) {
  const canvas = stage.getBoundingClientRect();
  const tolerance = 2 * canvas.width / stage.offsetWidth;
  const warnings: { kind: string; elementIds: string[] }[] = [];
  const textElements = Array.from(stage.querySelectorAll<HTMLElement>("[data-element-id]")).flatMap((element) => {
    const id = element.dataset.elementId;
    if (!id) return [];
    const lines: DOMRect[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || parent?.closest("[data-element-id]") !== element || parent.closest('[aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      lines.push(...Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0));
    }
    if (!lines.length) return [];
    const outside = (rect: DOMRect, boundary: DOMRect) => rect.left < boundary.left - tolerance || rect.right > boundary.right + tolerance || rect.top < boundary.top - tolerance || rect.bottom > boundary.bottom + tolerance;
    if (lines.some((rect) => outside(rect, element.getBoundingClientRect()))) warnings.push({ kind: "text_overflow", elementIds: [id] });
    if (lines.some((rect) => outside(rect, canvas))) warnings.push({ kind: "outside_slide", elementIds: [id] });
    return [{ id, lines }];
  });
  for (let i = 0; i < textElements.length; i++) {
    for (let j = i + 1; j < textElements.length; j++) {
      const a = textElements[i]!, b = textElements[j]!;
      if (a.lines.some((left) => b.lines.some((right) => Math.min(left.right, right.right) - Math.max(left.left, right.left) > tolerance && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > tolerance)))
        warnings.push({ kind: "text_overlap", elementIds: [a.id, b.id] });
    }
  }
  return {
    width: stage.offsetWidth, height: stage.offsetHeight,
    warnings: warnings.slice(0, 100), truncated: warnings.length > 100,
    guidance: "These are potential issues measured from rendered text. Inspect the attached slide image; intended overlaps, rotated text and complex graphics need visual judgment. Fix unintended collisions or clipping before finishing.",
  };
}

export async function pptxVisualFeedback(host: HTMLElement | null) {
  const stage = host?.querySelector<HTMLElement>('[data-pptx-viewport] [aria-roledescription="slide"]');
  if (!stage || !stage.offsetWidth || !stage.offsetHeight) return { preview: { available: false, error: "The slide canvas is not rendered. Reopen the viewer and retry preview before claiming visual verification." } };
  await document.fonts.ready;
  const layout = inspectSlideTextLayout(stage);
  try {
    // Export the full live slide at a useful resolution, independent of sidebar
    // width/zoom. Only the cloned DOM changes; the user's view and focus stay put.
    const canvas = await renderToCanvas(stage, {
      width: stage.offsetWidth, height: stage.offsetHeight,
      scale: Math.min(1.5, 1600 / Math.max(stage.offsetWidth, stage.offsetHeight)),
      backgroundColor: "#ffffff", useCORS: true, allowTaint: false, logging: false,
      onclone: (_document, clone) => { clone.style.transform = "none"; },
      ignoreElements: (element) => element.getAttribute("data-export-ignore") === "true" || element.hasAttribute("data-pptx-handle-for"),
    });
    return { layout, preview: { available: true, mime: "image/png", width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL("image/png") } };
  } catch (error) {
    return { layout, preview: { available: false, error: `Slide preview failed: ${error instanceof Error ? error.message : String(error)}. The layout warnings alone are not visual verification; retry preview.` } };
  }
}
