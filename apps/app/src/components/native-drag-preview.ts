let dismissPreview: (() => void) | undefined;

/** A solid, cursor-following surface instead of the browser's translucent text ghost. */
export function startNativeDragPreview(event: { dataTransfer: DataTransfer; clientX: number; clientY: number }, source: HTMLElement) {
  dismissPreview?.();
  const preview = source.cloneNode(true);
  if (!(preview instanceof HTMLElement)) return;
  preview.removeAttribute("id");
  preview.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
  preview.setAttribute("aria-hidden", "true");
  preview.inert = true;
  preview.className = "lw-native-drag-preview";
  preview.style.width = `${source.getBoundingClientRect().width}px`;
  document.body.append(preview);
  // The native image is transparent; the visible preview stays fully opaque.
  const image = document.createElement("canvas");
  image.width = image.height = 1;
  image.style.cssText = "position:fixed;pointer-events:none;left:-10px;top:-10px";
  document.body.append(image);
  event.dataTransfer.setDragImage(image, 0, 0);
  const move = (point: { clientX: number; clientY: number }) => {
    preview.style.transform = `translate3d(${point.clientX + 12}px, ${point.clientY + 12}px, 0)`;
  };
  move(event);
  const leave = (event: DragEvent) => { if (!event.relatedTarget) preview.style.opacity = "0"; };
  const over = (event: DragEvent) => { preview.style.opacity = "1"; move(event); };
  const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") cleanup(); };
  const cleanup = () => {
    preview.remove(); image.remove();
    window.removeEventListener("dragover", over, true);
    window.removeEventListener("dragleave", leave, true);
    window.removeEventListener("drop", cleanup, true);
    window.removeEventListener("dragend", cleanup, true);
    window.removeEventListener("blur", cleanup);
    window.removeEventListener("keydown", cancel);
    if (dismissPreview === cleanup) dismissPreview = undefined;
  };
  window.addEventListener("dragover", over, true);
  window.addEventListener("dragleave", leave, true);
  window.addEventListener("drop", cleanup, true);
  window.addEventListener("dragend", cleanup, true);
  window.addEventListener("blur", cleanup);
  window.addEventListener("keydown", cancel);
  dismissPreview = cleanup;
}
