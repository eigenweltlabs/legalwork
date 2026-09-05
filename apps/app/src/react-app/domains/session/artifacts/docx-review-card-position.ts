/** Position the native card from the rendered text, independent of the sidebar's
 * collision stack and the document's zoomed coordinate system. */
export function positionDocxReviewCard(host: HTMLElement, wrapper: HTMLElement, mark: HTMLElement, fragment: number) {
  const viewport = host.querySelector<HTMLElement>(".docx-editor__scroll-container");
  const parent = wrapper.parentElement;
  const rects = mark.getClientRects();
  const anchor = rects[Math.min(fragment, rects.length - 1)];
  if (!viewport || !parent || !anchor || !parent.offsetWidth) return;
  const bounds = viewport.getBoundingClientRect();
  const origin = parent.getBoundingClientRect();
  const scale = origin.width / parent.offsetWidth;
  if (!scale) return;
  const gutter = 12;
  const width = Math.min(340, viewport.clientWidth - gutter * 2);
  const set = (name: string, value: string) => {
    if (wrapper.style.getPropertyValue(name) !== value) wrapper.style.setProperty(name, value);
  };
  wrapper.dataset.docxReviewAnchor = "";
  set("--docx-review-width", `${width}px`);
  set("--docx-review-scale", String(1 / scale));
  set("--docx-review-max-height", `${bounds.height - gutter * 2}px`);
  const height = wrapper.getBoundingClientRect().height;
  const minLeft = bounds.left + gutter;
  const maxLeft = bounds.left + viewport.clientWidth - gutter - width;
  const minTop = bounds.top + gutter;
  const maxTop = Math.max(minTop, bounds.bottom - gutter - height);
  const pageRight = mark.closest(".layout-page")?.getBoundingClientRect().right ?? anchor.right;
  // Prefer the page's review rail, then the space beside the clicked text.
  let left = pageRight + gutter;
  if (left > maxLeft) left = anchor.right + gutter;
  if (left > maxLeft) left = anchor.left - gutter - width >= minLeft
    ? anchor.left - gutter - width : maxLeft;
  left = Math.max(minLeft, Math.min(maxLeft, left));
  let top = anchor.top;
  if (left < anchor.right && left + width > anchor.left) {
    // When there is no horizontal room, put the card below/above the line.
    top = anchor.bottom + gutter;
    if (top > maxTop) top = anchor.top - gutter - height;
  }
  top = Math.max(minTop, Math.min(maxTop, top));
  set("--docx-review-left", `${(left - origin.left) / scale}px`);
  set("--docx-review-top", `${(top - origin.top) / scale}px`);
  set("--docx-review-visibility", anchor.bottom > bounds.top && anchor.top < bounds.bottom
    && anchor.right > bounds.left && anchor.left < bounds.right ? "visible" : "hidden");
}
