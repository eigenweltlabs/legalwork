import { addDays, dayDate, dayInZone, zonedInstant } from "./dates.js";
import { ApiError } from "../errors.js";

/** Keep a recurring all-day reminder on the receipt's local cutoff clock. */
export function reminderInstant(start: string, zone: string, recurring: boolean, calculation?: { deadlineDay: string; cutoff: string; timeZone: string }): string {
  if (!calculation) return zonedInstant(start, zone);
  const cutoff = new Date(calculation.cutoff);
  if (!Number.isFinite(cutoff.getTime())) throw new ApiError(400, "invalid_calendar_date", "Invalid calculation cutoff.");
  if (!recurring) return cutoff.toISOString();
  // Timed recurrence instances carry their own explicit filing time.
  if (start.length !== 10) return zonedInstant(start, zone);
  const cutoffDay = dayInZone(cutoff.toISOString(), calculation.timeZone);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: calculation.timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(cutoff);
  const dayOffset = (dayDate(cutoffDay).getTime() - dayDate(calculation.deadlineDay).getTime()) / 86400000;
  const target = `${addDays(start, dayOffset)}T${clock}`;
  return new Date(Date.parse(zonedInstant(target, calculation.timeZone)) + cutoff.getUTCMilliseconds()).toISOString();
}
