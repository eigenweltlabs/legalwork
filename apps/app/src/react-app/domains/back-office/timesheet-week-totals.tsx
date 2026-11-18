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
  return (
    <div className="bo-time-week" role="group" aria-label={t("timesheets.ledger.worked_total")}>
      {dates.map(day => (
        <button type="button" key={day} aria-pressed={day === date} onClick={() => onDateChange(day)}>
          {new Date(day + "T12:00:00").toLocaleDateString(locale, { weekday: "short", day: "numeric" })}
          {" · "}{duration(workedByDate.get(day) ?? 0)} h
        </button>
      ))}
    </div>
  );
}
