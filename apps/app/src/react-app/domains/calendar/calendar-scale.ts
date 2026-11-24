export const CALENDAR_ZOOM_MIN = 0.5;
export const CALENDAR_ZOOM_MAX = 8;
export const CALENDAR_ZOOM_KEY = "legalwork.calendar.time-scale";

export function clampCalendarZoom(value: number) {
  return Number.isFinite(value) ? Math.max(CALENDAR_ZOOM_MIN, Math.min(CALENDAR_ZOOM_MAX, value)) : 1;
}

export function readCalendarZoom() {
  try {
    const value = window.localStorage.getItem(CALENDAR_ZOOM_KEY);
    return value === null ? 1 : clampCalendarZoom(Number(value));
  } catch { return 1; }
}
