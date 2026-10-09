import { tabStripInsertion, tabStripPreview } from "./tab-strip-drop";

/** Keep native drag sources mounted; animate siblings into their proposed slots. */
export function createTabStripPreview(element: HTMLElement, draggedId: string) {
  const list = element.querySelector<HTMLElement>(".lw-panel-tab-list");
  const viewport = list?.parentElement;
  if (!list || !viewport) return null;
  const items = Array.from(list.querySelectorAll<HTMLElement>(".lw-panel-tab-item")).flatMap(element => {
    const id = element.querySelector<HTMLElement>("[data-panel-tab-id]")?.dataset.panelTabId;
    const rect = element.getBoundingClientRect();
    return id ? [{ id, element, left: rect.left, right: rect.right }] : [];
  });
  const originLeft = list.getBoundingClientRect().left;
  const source = document.getElementById(draggedId);
  if (!source) return null;
  const width = source.getBoundingClientRect().width;
  const gap = parseFloat(getComputedStyle(list).columnGap) || 0;
  const padding = list.style.paddingRight;
  const external = !items.some(item => item.id === draggedId);
  if (external) list.style.paddingRight = `${width + gap}px`;
  const placeholder = document.createElement("div");
  placeholder.className = "lw-tab-drop-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.style.width = `${width}px`;
  list.append(placeholder);
  items.forEach(item => {
    item.element.dataset.tabDragPreview = "";
    if (item.id === draggedId) item.element.dataset.tabGapSource = "";
  });
  return {
    at(clientX: number, scroll = true) {
      const bounds = viewport.getBoundingClientRect();
      if (scroll && clientX < bounds.left + 24) viewport.scrollLeft -= 12;
      else if (scroll && clientX > bounds.right - 24) viewport.scrollLeft += 12;
      const currentLeft = list.getBoundingClientRect().left;
      const delta = currentLeft - originLeft;
      const slots = items.map(item => ({ id: item.id, left: item.left + delta, right: item.right + delta }));
      const { beforeId } = tabStripInsertion(clientX, slots, draggedId);
      const preview = tabStripPreview(slots, draggedId, beforeId, width, gap);
      items.forEach(item => item.element.style.setProperty("--lw-tab-drag-x", `${preview.offsets.get(item.id) ?? 0}px`));
      placeholder.style.left = `${items.length ? preview.placeholder - currentLeft : 0}px`;
      return beforeId;
    },
    clear() {
      placeholder.remove(); list.style.paddingRight = padding;
      items.forEach(item => {
        delete item.element.dataset.tabDragPreview;
        delete item.element.dataset.tabGapSource;
        item.element.style.removeProperty("--lw-tab-drag-x");
      });
    },
  };
}
