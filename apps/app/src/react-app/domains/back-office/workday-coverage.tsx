import { t } from "@/i18n";

export function WorkdayCoverage({ date, checkedThrough, now = Date.now() }: {
  date: string; checkedThrough?: string; now?: number;
}) {
  const start = new Date(date + "T00:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const through = checkedThrough ? Math.min(end.getTime(), Date.parse(checkedThrough)) : start.getTime();
  const elapsed = Math.min(end.getTime(), Math.max(start.getTime(), now));
  const covered = Math.max(start.getTime(), Math.min(elapsed, through));
  const fraction = (instant: number) => 100 * (instant - start.getTime()) / (end.getTime() - start.getTime());
  const format = (instant: number) => new Date(instant).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const unchecked = elapsed - covered >= 60_000 && t("timeWorkspace.coverageGap", {
    start: format(covered), end: elapsed === end.getTime() ? "24:00" : format(elapsed),
  });
  const label = covered <= start.getTime() ? t("timeWorkspace.coverageNone")
    : covered >= end.getTime() ? t("timeWorkspace.coverageFull")
    : t("timeWorkspace.coverageUntil", { time: format(covered) });
  return <div className="flex min-w-24 max-w-56 flex-1 flex-col gap-1 text-xs text-muted-foreground">
    <span>{unchecked || label}</span>
    <div aria-hidden="true" className="flex h-1 overflow-hidden rounded-full bg-muted/35">
      <span className="bg-primary/70" style={{ width: fraction(covered) + "%" }} />
      <span className="bg-muted-foreground/30" style={{ width: fraction(elapsed) - fraction(covered) + "%" }} />
    </div>
  </div>;
}
