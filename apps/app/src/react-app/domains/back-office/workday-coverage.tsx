import { Sparkles } from "lucide-react";
import { currentLocale, t } from "@/i18n";
import { calendarDay } from "../calendar/calendar-format";
import { CALENDAR_HOUR_HEIGHT } from "../calendar/calendar-layout";

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
  const minutes = end - start;
  if (minutes <= 0) return null;
  const fitsLabel = minutes * CALENDAR_HOUR_HEIGHT / 60 >= 24;
  const format = (value: number) => value === 1440 ? "24:00" :
    new Date(2000, 0, 1, 0, value).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
  const label = t("timeWorkspace.coverageGap", { start: format(start), end: format(end) });
  const action = t("timeWorkspace.checkForSuggestions");
  return <button type="button" disabled={busy} data-workday-unchecked
    aria-label={label + ". " + action} title={label + ". " + action}
    onClick={onCheck} className="time-coverage-overlay"
    style={{ top: start / 1440 * 100 + "%", height: minutes / 1440 * 100 + "%" }}>
    {fitsLabel && <span className="time-coverage-label"><Sparkles size={12} /><span>{label} · {action}</span></span>}
  </button>;
}
