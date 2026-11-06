import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { BackOfficeRecord } from "@legalwork/types/back-office";

// Keep record movement inside the renderer. Never start an OS-native HTML drag.
export function useRecordDrag(
  onDrop: (record: BackOfficeRecord, target: string) => void,
) {
  const callback = useRef(onDrop);
  callback.current = onDrop;
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const [over, setOver] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const start = (
    record: BackOfficeRecord,
    event: PointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const control =
      event.target instanceof Element
        ? event.target.closest("button,a,input,textarea,select,[role=combobox]")
        : null;
    if (control && !control.classList.contains("bo-record-title")) return;
    cleanup.current?.();
    const pointerId = event.pointerId,
      originX = event.clientX,
      originY = event.clientY;
    let active = false;
    const targetAt = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-bo-drop]")
        ?.dataset.boDrop ?? null;
    const clear = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", keydown, true);
      document.removeEventListener("visibilitychange", visibility);
      cleanup.current = null;
      setOver(null);
      setPreview(null);
    };
    const cancel = () => {
      suppressClick.current = false;
      clear();
    };
    const keydown = (key: globalThis.KeyboardEvent) => {
      if (key.key === "Escape") {
        key.preventDefault();
        cancel();
      }
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    const move = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      if (!(pointer.buttons & 1)) {
        cancel();
        return;
      }
      if (
        !active &&
        Math.hypot(pointer.clientX - originX, pointer.clientY - originY) < 5
      )
        return;
      active = true;
      pointer.preventDefault();
      window.getSelection()?.removeAllRanges();
      setPreview({
        name: String(record.values.name ?? ""),
        x: pointer.clientX,
        y: pointer.clientY,
      });
      setOver(targetAt(pointer.clientX, pointer.clientY));
    };
    const finish = (pointer: globalThis.PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const target = active ? targetAt(pointer.clientX, pointer.clientY) : null;
      suppressClick.current = active;
      if (active) pointer.preventDefault();
      clear();
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (target !== null) callback.current(record, target);
    };
    cleanup.current = clear;
    window.addEventListener("pointermove", move, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", keydown, true);
    document.addEventListener("visibilitychange", visibility);
  };
  const preventClick = (event: MouseEvent<HTMLElement>) => {
    if (suppressClick.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressClick.current = false;
    }
  };
  return {
    start,
    over,
    preventClick,
    preview: preview
      ? createPortal(
          <div
            className="bo-pointer-drag-preview"
            style={{ left: preview.x + 10, top: preview.y + 10 }}
          >
            {preview.name}
          </div>,
          document.body,
        )
      : null,
  };
}
