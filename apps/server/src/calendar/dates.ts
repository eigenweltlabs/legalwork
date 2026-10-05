import { ApiError } from "../errors.js";

export function dayOf(date: Date): string { return date.toISOString().slice(0, 10); }
export function dayDate(day: string): Date {
  const date = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(date.getTime()) || dayOf(date) !== day)
    throw new ApiError(400, "invalid_calendar_date", "Use a valid calendar date.");
  return date;
}
export function addDays(day: string, count: number): string {
  const date = dayDate(day); date.setUTCDate(date.getUTCDate() + count); return dayOf(date);
}
export function weekday(day: string): number { return dayDate(day).getUTCDay(); }
export function zoneValid(zone: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return true; } catch { return false; }
}
function localAt(instant: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const part = (name: string) => parts.find(p => p.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}
/** Reject gaps and folds; an explicit ISO offset resolves an ambiguous wall time. */
export function zonedInstant(value: string, zone: string): string {
  if (!zoneValid(zone)) throw new ApiError(400, "invalid_calendar_zone", "Use a valid IANA time zone.");
  if (/Z$|[+-]\d\d:\d\d$/.test(value)) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new ApiError(400, "invalid_calendar_date", "Invalid date and time.");
    return date.toISOString();
  }
  const local = value.length === 10 ? `${value}T00:00:00` : value;
  dayDate(local.slice(0, 10));
  const nominal = Date.parse(`${local}Z`);
  if (!Number.isFinite(nominal)) throw new ApiError(400, "invalid_calendar_date", "Invalid date and time.");
  const candidates = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = nominal + delta;
    const offset = Date.parse(`${localAt(sample, zone)}Z`) - sample;
    const candidate = nominal - offset;
    if (localAt(candidate, zone) === local) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new ApiError(400, "ambiguous_calendar_time", "This local time is missing or ambiguous. Provide a date and time with an explicit UTC offset.");
  return new Date([...candidates][0]).toISOString();
}
export function dayInZone(instant: string, zone: string): string { return localAt(Date.parse(instant), zone).slice(0, 10); }
