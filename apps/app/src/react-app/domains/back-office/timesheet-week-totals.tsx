import { useTimeDurationFormat } from "./time-duration-controls";
import { formatTimeDuration } from "./time-duration";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { offsetDate, periodLabels, timePeriods, weekDates, type TimePeriod, type TimeTotals } from "./timesheet-row";

export function TimesheetPeriodSwitch({ period, onChange }: { period: TimePeriod; onChange: (period: TimePeriod) => void }) {
  return (
    <div className="bo-time-period" role="group" aria-label={t("timesheets.ledger.period")}>
      {timePeriods.map(value => <Button key={value} type="button" variant={period === value ? "secondary" : "ghost"} size="xs" aria-pressed={period === value}
        onClick={() => onChange(value)}>{t(periodLabels[value])}</Button>)}
    </div>
  );
}

export function TimesheetWeekTotals({ dates, date, totalsByDate, onDateChange }: {
  dates: readonly string[];
  date: string;
  totalsByDate: ReadonlyMap<string, TimeTotals>;
  onDateChange: (date: string) => void;
}) {
  const locale = useLocale();
  const format = useTimeDurationFormat();
  if (dates.length < 2) return null;
  const month = dates.length > 7;
  const weekdays = weekDates(dates[0]);
  const weeks = [];
  for (let monday = weekdays[0]; monday <= dates[dates.length - 1]; monday = offsetDate(monday, 7)) {
    weeks.push(weekDates(monday));
  }
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" });
  const fullDate = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
  return (
    <div className={"bo-time-week" + (month ? " bo-time-month" : "")}>
      <table aria-label={t(month ? "calendar.month" : "calendar.week")}>
        <thead>
          <tr>{weekdays.map(day => <th key={day} scope="col">{weekday.format(new Date(day + "T12:00:00"))}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map(week => (
            <tr key={week[0]}>
              {week.map(day => {
                if (!dates.includes(day)) return <td key={day} />;
                const totals = totalsByDate.get(day);
                const recorded = t("timesheets.sheet.worked", { minutes: totals?.worked ?? 0 });
                const billable = t("timesheets.sheet.charge", { minutes: totals?.charge ?? 0 });
                const localDay = new Date(day + "T12:00:00");
                return (
                  <td key={day}>
                    <button type="button" aria-pressed={day === date}
                      title={`${recorded} · ${billable}`} aria-label={`${fullDate.format(localDay)}. ${recorded}. ${billable}.`} onClick={() => onDateChange(day)}>
                      <time dateTime={day}>{localDay.getDate()}</time>
                      <span>{formatTimeDuration(totals?.worked ?? 0, format)} · {formatTimeDuration(totals?.charge ?? 0, format)}</span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
