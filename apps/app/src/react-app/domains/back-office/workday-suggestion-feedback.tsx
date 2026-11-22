import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { WorkdayGenerationProgress } from "@legalwork/types/time-capture";
import { formatCalendarDay } from "../calendar/calendar-format";

const phases = {
  collecting: "timeWorkspace.collectingActivity",
  grouping: "timeWorkspace.groupingActivity",
  wording: "timeWorkspace.preparingDrafts",
  saving: "timeWorkspace.savingDrafts",
} as const;

export function WorkdaySuggestionFeedback({ date, confirm, running, progress, finished, onStart, onCancel }: {
  date: string; confirm: boolean; running: boolean; progress?: WorkdayGenerationProgress | null;
  finished?: number; onStart: () => void; onCancel: () => void;
}) {
  if (running) {
    const phase = t(phases[progress?.phase ?? "collecting"]);
    const total = progress?.total;
    return <div className="time-suggestion-feedback">
      <div className="flex items-center justify-between gap-2">
        <span role="status">{phase}{typeof total === "number" && total > 0 && " · " + (progress?.completed ?? 0) + " / " + total}</span>
        <Button variant="ghost" size="xs" onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
      <progress aria-label={phase} className="time-suggestion-progress" max={total || 1}
        value={total ? progress?.completed : undefined} />
    </div>;
  }
  if (confirm) return <div className="time-suggestion-feedback">
    <p role="status">{t("timeWorkspace.confirmGeneration", { date: formatCalendarDay(date, { dateStyle: "long" }) })}</p>
    <div className="mt-2 flex items-center gap-2">
      <Button size="sm" onClick={onStart}>{t("timeWorkspace.createSuggestions")}</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
    </div>
  </div>;
  if (finished !== undefined) return <p className="time-workspace-note" role="status">
    {finished ? t("timeWorkspace.finishedGeneration", { count: finished }) : t("timeWorkspace.finishedEmpty")}
  </p>;
  return null;
}
