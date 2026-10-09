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
  const showReview = item.kind === "deadline" && !item.verified && !(item.provenance?.kind === "manual" && !item.provenance.reason?.trim());
  const showMeta = item.recurring || showReview || isCompleted(item);
  return <Button variant="ghost" onClick={onOpen} title={`${item.title} · ${item.projectName} · ${occurrenceTime(item)}`}
    className={cn("block h-auto w-full min-w-0 space-y-1.5 rounded-lg border px-2.5 py-2 text-left font-normal whitespace-normal text-foreground", compact ? "text-[11px]" : "text-xs", color.card, isCompleted(item) && "opacity-60")}>
    <span className={cn("flex min-w-0 items-center gap-1.5 text-[10px] leading-4", color.accent)}>
      <Icon aria-label={calendarKindLabel(item.kind)} className="size-3.5 shrink-0" />
      {showProject && <span className="min-w-0 flex-1 truncate">{item.projectName}</span>}
      {!item.allDay && <span className="ms-auto shrink-0 tabular-nums">{occurrenceTime(item)}</span>}
    </span>
    <span className={cn("block leading-[1.45] font-medium [overflow-wrap:anywhere]", compact ? "line-clamp-2" : "line-clamp-3", isCompleted(item) && "line-through")}>{item.title}</span>
    {!compact && showMeta && <span className="flex flex-wrap items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
      {item.recurring && <Repeat2 className="size-3" aria-label={t("calendar.recurring")} />}
      {showReview && <span>{deadlineReviewLabel(item)}</span>}
      {isCompleted(item) && <CircleCheck className="size-3" aria-label={t("calendar.completed")} />}
    </span>}
  </Button>;
}
