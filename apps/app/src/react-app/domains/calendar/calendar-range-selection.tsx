import { useEffect, useRef, useState } from "react";
import { currentLocale, t } from "@/i18n";

export type CalendarRangeSelection = (date: string, start: number, end: number, lane: string, trigger: HTMLElement) => void;
type Range = { start: number; end: number };
const step = 15;
const lastMinute = 24 * 60;
const limit = (minute: number) => Math.max(0, Math.min(minute, lastMinute));

function minuteAt(button: HTMLElement, y: number) {
  const bounds = button.getBoundingClientRect();
  return limit((y - bounds.top) * lastMinute / bounds.height);
}
function clickRange(minute: number): Range {
  const start = Math.min(lastMinute - step, Math.floor(minute / step) * step);
  return { start, end: Math.min(start + 30, lastMinute) };
}
export function calendarTimeRange(anchor: number, minute: number, dragged: boolean): Range {
  const initial = clickRange(anchor);
  if (!dragged) return initial;
  const endpoint = limit(Math.round(minute / step) * step);
  if (endpoint === initial.start) return { start: initial.start, end: initial.start + step };
  return { start: Math.min(initial.start, endpoint), end: Math.max(initial.start, endpoint) };
}
function timeLabel(minute: number) {
  return new Date(2000, 0, 1, 0, minute).toLocaleTimeString(currentLocale(), { hour: "numeric", minute: "2-digit" });
}

export function CalendarRangeTarget({ date, lane, onSelect }: { date: string; lane: string; onSelect: CalendarRangeSelection }) {
  const drag = useRef<{ pointer: number; y: number; lastY: number; anchor: number; button: HTMLButtonElement; viewport: HTMLElement | null } | null>(null);
  const frame = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); }, []);
  const completed = useRef<Range | undefined>(undefined);
  const [preview, setPreview] = useState<Range>();
  function currentRange(pointerId: number, clientY: number) {
    const active = drag.current;
    if (!active || active.pointer !== pointerId) return;
    return calendarTimeRange(active.anchor, minuteAt(active.button, clientY), Math.abs(clientY - active.y) >= 4);
  }
  function scrollEdge() {
    frame.current = undefined;
    const active = drag.current;
    if (!active?.viewport || Math.abs(active.lastY - active.y) < 4) return;
    const bounds = active.viewport.getBoundingClientRect();
    const margin = 32;
    const top = Math.max(0, margin - (active.lastY - bounds.top));
    const bottom = Math.max(0, margin - (bounds.bottom - active.lastY));
    const speed = Math.max(-12, Math.min(12, (bottom - top) / 3));
    if (!speed) return;
    const previous = active.viewport.scrollTop;
    active.viewport.scrollTop += Math.sign(speed) * Math.ceil(Math.abs(speed));
    if (active.viewport.scrollTop === previous) return;
    setPreview(currentRange(active.pointer, active.lastY));
    frame.current = requestAnimationFrame(scrollEdge);
  }
  function reset() {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    drag.current = null;
    setPreview(undefined);
  }
  return <>
    <button type="button" data-calendar-create-range aria-label={t("timeWorkspace.selectRange")}
      className="absolute inset-0 cursor-crosshair touch-pan-y select-none focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-ring"
      onPointerDown={event => {
        if (!event.isPrimary || event.button !== 0) return;
        completed.current = undefined;
        const anchor = minuteAt(event.currentTarget, event.clientY);
        drag.current = { pointer: event.pointerId, y: event.clientY, lastY: event.clientY, anchor, button: event.currentTarget,
          viewport: event.currentTarget.closest<HTMLElement>("[data-calendar-time-grid]") };
        event.currentTarget.setPointerCapture(event.pointerId);
        if (event.pointerType !== "touch") setPreview(clickRange(anchor));
      }}
      onPointerMove={event => {
        if (!drag.current || event.pointerType === "touch" || drag.current.pointer !== event.pointerId) return;
        drag.current.lastY = event.clientY;
        setPreview(currentRange(event.pointerId, event.clientY));
        if (frame.current === undefined) frame.current = requestAnimationFrame(scrollEdge);
      }}
      onPointerCancel={reset} onLostPointerCapture={reset}
      onKeyDown={event => { if (event.key === "Escape" && drag.current) { event.preventDefault(); reset(); } }}
      onPointerUp={event => {
        completed.current = currentRange(event.pointerId, event.clientY);
        reset();
      }}
      onClick={event => {
        if (event.detail !== 0) {
          const range = completed.current;
          completed.current = undefined;
          if (range) onSelect(date, range.start, range.end, lane, event.currentTarget);
          return;
        }
        // Keyboard activation starts in the visible portion of the scrolled day.
        const button = event.currentTarget;
        const viewport = button.closest("[data-calendar-time-grid]")?.getBoundingClientRect();
        const range = clickRange(viewport ? minuteAt(button, viewport.top + viewport.height / 2) : 9 * 60);
        onSelect(date, range.start, range.end, lane, button);
      }} />
    {preview && <div data-calendar-range-preview aria-hidden className="pointer-events-none absolute inset-x-0.5 z-20 overflow-hidden rounded-sm border border-primary bg-background px-1.5 text-xs font-medium tabular-nums text-primary shadow-sm"
      style={{ top: 100 * preview.start / lastMinute + "%", height: 100 * (preview.end - preview.start) / lastMinute + "%" }}>
      {timeLabel(preview.start)} – {timeLabel(preview.end)}
    </div>}
  </>;
}
