import { useRef } from "react";
import { t } from "@/i18n";

const minWidth = 88;
const maxWidth = 800;

export function ColumnResizeHandle({ label, width, onResize }: {
  label: string;
  width: number;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number; direction: number } | null>(null);
  const resize = (value: number) => onResize(Math.max(minWidth, Math.min(maxWidth, Math.round(value))));
  return <div className="bo-column-resizer" role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={t("back_office.resize_column", { name: label })} aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width}
    onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.focus({ preventScroll: true });
      drag.current = { pointerId: event.pointerId, x: event.clientX, width, direction: getComputedStyle(handle).direction === "rtl" ? -1 : 1 };
      handle.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.pointerId === event.pointerId) resize(start.width + (event.clientX - start.x) * start.direction);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      resize(width + (event.key === "ArrowRight" ? 8 : -8) * direction);
    }}
  />;
}
