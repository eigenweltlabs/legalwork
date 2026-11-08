import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";
import { useThemeContainer } from "twenty-ui/theme";
import type { BackOfficeRecord } from "@legalwork/types/back-office";

// Keep record movement inside the renderer. Never start an OS-native HTML drag.
export function useRecordDrag(
  onDrop: (record: BackOfficeRecord, target: string) => void,
) {
  const themeContainer = useThemeContainer();
  const surface = useRef<HTMLDivElement>(null);
  const callback = useRef(onDrop);
  callback.current = onDrop;
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cleanup.current?.(), []);

  const start = (record: BackOfficeRecord, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary || !surface.current) return;
    const control = event.target instanceof Element
      ? event.target.closest("button,a,input,textarea,select,[role=combobox]")
      : null;
    if (control && !control.classList.contains("bo-record-title")) return;
    cleanup.current?.();
    const board = surface.current;
    const { pointerId, clientX: originX, clientY: originY } = event;
    let x = originX, y = originY;
    let preview: HTMLDivElement | undefined;
    let over: HTMLElement | null = null;
    let frame: number | undefined;

    const targetAt = (x: number, y: number) => {
      const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-bo-drop]");
      return target && board.contains(target) ? target : null;
    };
    // Pointer coordinates never enter React state. Paint the latest sample once per frame.
    const paint = () => {
      frame = undefined;
      const target = targetAt(x, y);
      if (target !== over) {
        over?.removeAttribute("data-bo-drag-over");
        target?.setAttribute("data-bo-drag-over", "");
        over = target;
      }
      if (preview) {
        preview.style.transform = `translate3d(${x + 10}px, ${y + 10}px, 0)`;
        if (!preview.isConnected) (themeContainer ?? board).append(preview);
      }
    };
    const clear = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", keydown, true);
      document.removeEventListener("visibilitychange", visibility);
      if (frame !== undefined) cancelAnimationFrame(frame);
      over?.removeAttribute("data-bo-drag-over");
      preview?.remove();
      cleanup.current = null;
    };
    const pointerCancel = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId === pointerId) clear();
    };
    const keydown = (key: KeyboardEvent) => {
      if (key.key === "Escape") {
        key.preventDefault();
        clear();
      }
    };
    const visibility = () => {
      if (document.hidden) clear();
    };
    const move = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (!(pointer.buttons & 1)) { clear(); return; }
      x = pointer.clientX;
      y = pointer.clientY;
      if (!preview) {
        if (Math.hypot(x - originX, y - originY) < 5) return;
        suppressClick.current = true;
        window.getSelection()?.removeAllRanges();
        preview = document.createElement("div");
        preview.className = "bo-pointer-drag-preview";
        preview.setAttribute("aria-hidden", "true");
        preview.textContent = String(record.values.name ?? "");
      }
      pointer.preventDefault();
      if (frame === undefined) frame = requestAnimationFrame(paint);
    };
    const finish = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const target = preview ? targetAt(pointer.clientX, pointer.clientY) : null;
      if (preview) pointer.preventDefault();
      clear();
      if (target?.dataset.boDrop !== undefined) callback.current(record, target.dataset.boDrop);
    };
    cleanup.current = clear;
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", keydown, true);
    document.addEventListener("visibilitychange", visibility);
  };
  const preventClick = (event: MouseEvent<HTMLElement>) => {
    if (suppressClick.current && event.detail !== 0) {
      event.preventDefault();
      event.stopPropagation();
      suppressClick.current = false;
    }
  };
  return {
    start,
    surfaceProps: {
      ref: surface,
      onPointerDownCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (event.isPrimary) suppressClick.current = false;
      },
      onClickCapture: preventClick,
    },
  };
}
