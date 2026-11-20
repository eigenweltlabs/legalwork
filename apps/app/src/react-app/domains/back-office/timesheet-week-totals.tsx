import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { duration } from "./timesheet-row";

export function TimesheetWeekTotals({ dates, date, workedByDate, onDateChange }: {
  dates: readonly string[];
  date: string;
  workedByDate: ReadonlyMap<string, number>;
  onDateChange: (date: string) => void;
}) {
  const locale = useLocale();
  if (dates.length < 2) return null;
  const month = dates.length > 7;
  const firstColumn = (new Date(dates[0] + "T12:00:00").getDay() + 6) % 7 + 1;
  return (
    <div className={"bo-time-week" + (month ? " bo-time-month" : "")} role="group" aria-label={t("timesheets.ledger.worked_total")}>
      {dates.map((day, index) => (
        <button type="button" key={day} style={month && index === 0 ? { gridColumnStart: firstColumn } : undefined} aria-pressed={day === date} onClick={() => onDateChange(day)}>
          {new Date(day + "T12:00:00").toLocaleDateString(locale, { weekday: "short", day: "numeric" })}
          {" · "}{duration(workedByDate.get(day) ?? 0)} h
        </button>
      ))}
    </div>
  );
}
