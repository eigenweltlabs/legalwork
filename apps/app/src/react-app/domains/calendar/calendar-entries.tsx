import { CalendarDays, CircleCheck, Repeat2, SquareCheck, Timer } from "lucide-react";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { deadlineReviewLabel, calendarKindLabel, isCompleted, occurrenceTime } from "./calendar-format";
import { calendarProjectColor } from "./calendar-colors";

export function CalendarEntry({ item, projectId = item.projectId, compact, showProject, onOpen }: {
  item: CalendarOccurrence; projectId?: string | null; compact?: boolean; showProject?: boolean; onOpen: () => void;
}) {
  const Icon = item.kind === "deadline" ? Timer : item.kind === "task" ? SquareCheck : CalendarDays;
  const color = calendarProjectColor(projectId);
  return <Button variant="ghost" onClick={onOpen} title={`${item.title} · ${item.projectName} · ${occurrenceTime(item)}`}
    className={cn("h-auto w-full min-w-0 items-start justify-start gap-2 rounded-lg border px-2 py-2 text-left font-normal whitespace-normal text-foreground", compact ? "text-[11px]" : "text-xs", color.card, isCompleted(item) && "opacity-60")}>
    <Icon aria-label={calendarKindLabel(item.kind)} className={cn("mt-0.5 size-3.5 shrink-0", color.accent)} />
    <span className="min-w-0 flex-1">
      {showProject && <span className={cn("mb-0.5 block truncate text-[10px] leading-4", color.accent)}>{item.projectName}</span>}
      <span className={cn("block leading-4 font-medium break-words", compact && "line-clamp-2", isCompleted(item) && "line-through")}>{item.title}</span>
      {!compact && <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] leading-4 text-muted-foreground">
        {!item.allDay && <span>{occurrenceTime(item)}</span>}
        {item.recurring && <Repeat2 className="size-3" aria-label={t("calendar.recurring")} />}
        {item.kind === "deadline" && !item.verified && <span>{deadlineReviewLabel(item)}</span>}
        {isCompleted(item) && <CircleCheck className="size-3" aria-label={t("calendar.completed")} />}
      </span>}
    </span>
  </Button>;
}
