import type { TaskSchedule } from "@legalwork/types/scheduled-tasks";
import { zoneValid, zonedInstant } from "../calendar/dates.js";
import { ApiError } from "../errors.js";

const invalid = (message: string) => new ApiError(400, "invalid_schedule", message);
const allowed = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTH", "BYMONTHDAY", "BYHOUR", "BYMINUTE", "COUNT", "UNTIL", "WKST"]);
const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function recurrence(rule: string) {
  const text = rule.replace(/^RRULE:/i, "").toUpperCase();
  const entries = text.split(";").map(part => part.split("="));
  if (entries.some(([key, value, extra]) => !allowed.has(key) || !value || extra !== undefined) || new Set(entries.map(([key]) => key)).size !== entries.length)
    throw invalid("Use a single RRULE with supported recurrence fields.");
  const fields: Record<string, string> = {};
  for (const [key, value] of entries) fields[key] = value;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(fields.FREQ))
    throw invalid("Custom schedules support daily, weekly, monthly or yearly rules. Use Interval for shorter repeats.");
  const ranges: Record<string, [number, number]> = { INTERVAL: [1, 1000], COUNT: [1, 10000], BYMONTH: [1, 12], BYMONTHDAY: [-31, 31], BYHOUR: [0, 23], BYMINUTE: [0, 59] };
  for (const [key, value] of entries) {
    const range = ranges[key];
    if (range && value.split(",").some(n => !/^-?\d+$/.test(n) || Number(n) < range[0] || Number(n) > range[1] || (key === "BYMONTHDAY" && Number(n) === 0))) throw invalid(`Invalid ${key} in schedule rule.`);
    if (["INTERVAL", "COUNT", "BYHOUR", "BYMINUTE"].includes(key) && value.includes(",")) throw invalid(`Use one ${key} value.`);
    if (key === "BYDAY" && value.split(",").some(day => !/^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.test(day))) throw invalid("Invalid weekday in schedule rule.");
    if (key === "WKST" && !weekdays.includes(value)) throw invalid("Invalid week start.");
    if (key === "UNTIL" && !/^\d{8}T\d{6}Z$/.test(value)) throw invalid("UNTIL must be a UTC date and time, such as 20261231T235959Z.");
  }
  if (fields.COUNT && fields.UNTIL) throw invalid("Use COUNT or UNTIL, not both.");
  if (fields.FREQ === "WEEKLY" && fields.BYMONTHDAY) throw invalid("Weekly rules do not support BYMONTHDAY.");
  if (fields.BYDAY && /\d/.test(fields.BYDAY) && (fields.FREQ === "DAILY" || fields.FREQ === "WEEKLY" || (fields.FREQ === "YEARLY" && !fields.BYMONTH)))
    throw invalid("Numbered weekdays require a monthly rule, or a yearly rule with BYMONTH.");
  return fields;
}

export function wallTime(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

/** Bounded calendar expansion. Impossible custom rules cannot stall the local server. */
export function nextOccurrence(schedule: TaskSchedule, after: number): string | null {
  if (!zoneValid(schedule.timeZone)) throw invalid("Choose a valid IANA time zone, such as Europe/Berlin.");
  const anchor = zonedInstant(schedule.startAt, schedule.timeZone), start = Date.parse(anchor);
  if (schedule.kind === "once") return start > after ? anchor : null;
  if (schedule.kind === "interval") {
    const step = schedule.minutes * 60000;
    return new Date(start + Math.max(0, Math.floor((after - start) / step) + 1) * step).toISOString();
  }
  const rule = recurrence(schedule.rrule), interval = Number(rule.INTERVAL ?? 1);
  const local = wallTime(anchor, schedule.timeZone), startDay = new Date(`${local.slice(0, 10)}T00:00:00Z`);
  const afterDay = wallTime(new Date(after).toISOString(), schedule.timeZone).slice(0, 10);
  const numbers = (key: string) => rule[key]?.split(",").map(Number);
  const months = numbers("BYMONTH"), monthDays = numbers("BYMONTHDAY"), days = rule.BYDAY?.split(",");
  const hour = rule.BYHOUR?.padStart(2, "0") ?? local.slice(11, 13), minute = rule.BYMINUTE?.padStart(2, "0") ?? local.slice(14, 16);
  const weekStart = weekdays.indexOf(rule.WKST ?? "MO");
  const weekOffset = (startDay.getUTCDay() - weekStart + 7) % 7;
  const untilText = rule.UNTIL?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
  const until = untilText ? Date.parse(untilText) : Infinity;
  if (untilText && (!Number.isFinite(until) || new Date(until).toISOString().slice(0, 19) + "Z" !== untilText)) throw invalid("UNTIL must be a real UTC date and time.");
  let count = 0;
  // At most 40 years, one possible run per day. Interval handles more frequent runs.
  for (let index = 0; index < 366 * 40; index++) {
    const date = new Date(startDay.getTime() + index * 86400000), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    const years = date.getUTCFullYear() - startDay.getUTCFullYear(), monthOffset = years * 12 + month - startDay.getUTCMonth() - 1;
    if (rule.FREQ === "DAILY" && index % interval || rule.FREQ === "WEEKLY" && Math.floor((index + weekOffset) / 7) % interval || rule.FREQ === "MONTHLY" && monthOffset % interval || rule.FREQ === "YEARLY" && years % interval) continue;
    if (months && !months.includes(month)) continue;
    const monthLength = new Date(Date.UTC(date.getUTCFullYear(), month, 0)).getUTCDate();
    if (monthDays && !monthDays.some(n => n === day || n < 0 && monthLength + n + 1 === day)) continue;
    if (days && !days.some(value => {
      if (!value.endsWith(weekdays[date.getUTCDay()])) return false;
      const ordinal = Number(value.slice(0, -2));
      return !ordinal || ordinal > 0 && Math.ceil(day / 7) === ordinal || ordinal < 0 && -Math.ceil((monthLength - day + 1) / 7) === ordinal;
    })) continue;
    if (rule.FREQ === "WEEKLY" && !days && date.getUTCDay() !== startDay.getUTCDay()) continue;
    if ((rule.FREQ === "MONTHLY" || rule.FREQ === "YEARLY") && !days && !monthDays && day !== startDay.getUTCDate()) continue;
    if (rule.FREQ === "YEARLY" && !months && !days && !monthDays && month !== startDay.getUTCMonth() + 1) continue;
    const candidate = `${date.toISOString().slice(0, 10)}T${hour}:${minute}:${local.slice(17, 19)}`;
    if (candidate < local) continue;
    // No need to convert historical dates when seeking an upcoming run.
    if (candidate.slice(0, 10) < afterDay && !rule.UNTIL && !rule.COUNT) continue;
    let instant: string;
    try { instant = zonedInstant(candidate, schedule.timeZone); }
    catch (error) {
      // A daylight-saving gap/fold is skipped, never silently shifted or run twice.
      if (error instanceof ApiError && error.code === "ambiguous_calendar_time") continue;
      throw error;
    }
    count++;
    if (rule.COUNT && count > Number(rule.COUNT)) return null;
    const time = Date.parse(instant);
    if (time > until) return null;
    if (time >= start && time > after) return instant;
  }
  throw invalid("No occurrence within the supported 40-year window. Check the rule or choose a more recent start date.");
}
