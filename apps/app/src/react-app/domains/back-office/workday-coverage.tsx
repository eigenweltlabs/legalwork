import { Sparkles } from "lucide-react";
import { currentLocale, t } from "@/i18n";
import { calendarDay } from "../calendar/calendar-format";

export function WorkdayCoverage({ date, checkedThrough, now, busy, onCheck }: {
  date: string; checkedThrough?: string; now: Date; busy: boolean; onCheck: () => void;
}) {
  const today = calendarDay(now);
  if (date > today) return null;
  const checked = checkedThrough ? new Date(checkedThrough) : undefined;
  const startDay = checked && calendarDay(checked);
  const minute = (time: Date) => time.getHours() * 60 + time.getMinutes();
  const start = !checked || !startDay || startDay < date ? 0 : startDay > date ? 1440 : minute(checked);
  const end = date === today ? minute(now) : 1440;
  if (start >= end) return null;
  const format = (value: number) => value === 1440 ? "24:00" :
    new Date(2000, 0, 1, 0, value).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
  const label = t("timeWorkspace.coverageGap", { start: format(start), end: format(end) });
  return <button type="button" disabled={busy} data-workday-unchecked
    aria-label={label + ". " + t("timeWorkspace.addSuggestions")} title={label + ". " + t("timeWorkspace.addSuggestions")}
    onClick={onCheck} className="time-coverage-overlay"
    style={{ top: start / 1440 * 100 + "%", height: (end - start) / 1440 * 100 + "%" }}>
    <span className="time-coverage-label"><Sparkles size={12} />{label}</span>
  </button>;
}
