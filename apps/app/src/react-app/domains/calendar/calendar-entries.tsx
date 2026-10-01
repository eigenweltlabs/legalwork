import { CalendarDays, CircleCheck, Repeat2, SquareCheck, Timer } from "lucide-react";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { calendarKindLabel, isCompleted, occurrenceTime } from "./calendar-format";

export function CalendarEntry({ item, compact, showProject, onOpen }: {
  item: CalendarOccurrence; compact?: boolean; showProject?: boolean; onOpen: () => void;
}) {
  const Icon = item.kind === "deadline" ? Timer : item.kind === "task" ? SquareCheck : CalendarDays;
  return <Button variant="ghost" onClick={onOpen} title={`${item.title} · ${item.projectName} · ${occurrenceTime(item)}`}
    className={cn("h-auto w-full min-w-0 items-start justify-start gap-2 rounded-lg border border-transparent px-2 py-2 text-left font-normal whitespace-normal", compact ? "text-[11px]" : "text-xs", item.kind === "deadline" ? "border-amber-6/50 bg-amber-3/40 hover:bg-amber-4/60" : "bg-muted/40 hover:bg-muted", isCompleted(item) && "opacity-60")}>
    <Icon aria-label={calendarKindLabel(item.kind)} className={cn("mt-0.5 size-3.5 shrink-0", item.kind === "deadline" ? "text-amber-11" : "text-muted-foreground")} />
    <span className="min-w-0 flex-1">
      <span className={cn("block leading-4 font-medium break-words", compact && "line-clamp-2", isCompleted(item) && "line-through")}>{item.title}</span>
      {!compact && <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] leading-4 text-muted-foreground">
        {showProject && <span className="truncate">{item.projectName}</span>}
        {!item.allDay && <span>{occurrenceTime(item)}</span>}
        {item.recurring && <Repeat2 className="size-3" aria-label={t("calendar.recurring")} />}
        {item.kind === "deadline" && !item.verified && <span>{t("calendar.unverified")}</span>}
        {isCompleted(item) && <CircleCheck className="size-3" aria-label={t("calendar.completed")} />}
      </span>}
    </span>
  </Button>;
}
