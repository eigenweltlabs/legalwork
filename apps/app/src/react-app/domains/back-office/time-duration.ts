import { t } from "@/i18n";

export type TimeDurationFormat = "hours" | "minutes";

export function formatTimeDuration(minutes: number, format: TimeDurationFormat) {
  return format === "minutes" ? String(minutes) : Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0");
}

/** Stored values stay in minutes. Only new keyboard input uses HHMM shorthand. */
export function parseTimeDuration(text: string, format: TimeDurationFormat): number | null {
  const value = text.trim();
  if (!value) return null;
  let minutes: number;
  if (/^\d+:\d{1,2}$/.test(value)) {
    const [hours, remainder] = value.split(":").map(Number);
    if (remainder >= 60) throw new Error(t("timeWorkspace.invalidDuration"));
    minutes = hours * 60 + remainder;
  } else if (/^\d+$/.test(value)) {
    const number = Number(value);
    if (format === "hours" && value.length > 2) {
      if (number % 100 >= 60) throw new Error(t("timeWorkspace.invalidDuration"));
      minutes = Math.floor(number / 100) * 60 + number % 100;
    } else minutes = number;
  } else throw new Error(t("timeWorkspace.invalidDuration"));
  if (!Number.isSafeInteger(minutes)) throw new Error(t("timeWorkspace.invalidDuration"));
  return minutes;
}

export function isTimeDurationField(objectId: string | undefined, fieldId: string) {
  return objectId === "timeEntries" && ["recordedMinutes", "billableMinutes", "nonBillableMinutes"].includes(fieldId);
}

export function isTimeAmountColumn(column: string) {
  return ["worked", "charge", "billableWork", "nonBillable"].includes(column);
}
