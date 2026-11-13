import { CalendarDays, CircleCheck, Repeat2, SquareCheck, Timer } from "lucide-react";
import type { CSSProperties } from "react";
import type { CalendarDisplayOccurrence } from "./connected-calendars";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { deadlineReviewLabel, calendarKindLabel, isCompleted, occurrenceTime, occurrenceTimeRange } from "./calendar-format";
import { calendarDisplayColor } from "./calendar-colors";

export function CalendarEntry({ item, projectId = item.projectId, compact, showProject, onOpen }: {
  item: CalendarDisplayOccurrence; projectId?: string | null; compact?: boolean; showProject?: boolean; onOpen: () => void;
}) {
  const Icon = item.kind === "deadline" ? Timer : item.kind === "task" ? SquareCheck : CalendarDays;
  const color = calendarDisplayColor(item.connectedEvent?.calendar.key ?? projectId, item.connectedEvent?.calendar.color);
  const showReview = item.kind === "deadline" && !item.verified && !(item.provenance?.kind === "manual" && !item.provenance.reason?.trim());
  const showMeta = item.recurring || showReview || isCompleted(item);
  const source = item.connectedEvent ? `${item.connectedEvent.calendar.providerName} · ${item.connectedEvent.calendar.name}` : item.projectName;
  if (compact) return <Button variant="ghost" style={color.style} onClick={onOpen} title={`${item.title} · ${source} · ${occurrenceTimeRange(item)}`}
    className={cn("flex h-5 w-full min-w-0 justify-start gap-1 overflow-hidden rounded-sm px-1.5 py-0 text-[10px] font-normal text-foreground", item.allDay ? cn("border", color.card) : "hover:bg-muted/60", isCompleted(item) && "opacity-60")}>
    <span aria-label={calendarKindLabel(item.kind)} className={cn("flex size-2 shrink-0 items-center justify-center", color.marker)}>{item.kind === "deadline" || item.kind === "task" ? <Icon className="size-2.5" /> : <span className="size-1.5 rounded-full bg-current ring-1 ring-inset ring-border/50" />}</span>
    {!item.allDay && <span className="shrink-0 text-[9px] text-muted-foreground tabular-nums">{occurrenceTime(item)}</span>}
    <span className={cn("min-w-0 truncate font-medium", isCompleted(item) && "line-through")}>{item.title}</span>
    {showReview && <span className="ms-auto shrink-0" title={deadlineReviewLabel(item)}>!</span>}
  </Button>;
  return <Button variant="ghost" style={color.style} onClick={onOpen} title={`${item.title} · ${source} · ${occurrenceTimeRange(item)}`}
    className={cn("flex h-auto w-full min-w-0 items-start justify-start gap-3 rounded-md px-3 py-2 text-left text-xs font-normal whitespace-normal text-foreground hover:bg-muted/40", isCompleted(item) && "opacity-60")}>
    <span className="w-28 shrink-0 pt-0.5 text-[10px] text-muted-foreground tabular-nums">{occurrenceTimeRange(item)}</span>
    <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full bg-current ring-1 ring-inset ring-border/50", color.marker)} />
    <span className="min-w-0 flex-1">
      <span className={cn("block leading-5 font-medium [overflow-wrap:anywhere]", isCompleted(item) && "line-through")}>{item.title}</span>
      {(showProject || item.connectedEvent) && <span className="block truncate text-[10px] leading-4 text-muted-foreground">{source}</span>}
    </span>
    <Icon aria-label={calendarKindLabel(item.kind)} className={cn("mt-0.5 size-3.5 shrink-0", color.accent)} />
    {showMeta && <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-[10px] leading-4 text-muted-foreground">
      {item.recurring && <Repeat2 className="size-3" aria-label={t("calendar.recurring")} />}
      {showReview && <span>{deadlineReviewLabel(item)}</span>}
      {isCompleted(item) && <CircleCheck className="size-3" aria-label={t("calendar.completed")} />}
    </span>}
  </Button>;
}

export function CalendarTimeBlock({ item, projectId = item.projectId, height, style, onOpen }: {
  item: CalendarDisplayOccurrence; projectId?: string | null; height: number; style: CSSProperties; onOpen: () => void;
}) {
  const color = calendarDisplayColor(item.connectedEvent?.calendar.key ?? projectId, item.connectedEvent?.calendar.color);
  const source = item.connectedEvent ? `${item.connectedEvent.calendar.providerName} · ${item.connectedEvent.calendar.name}` : item.projectName;
  const review = item.kind === "deadline" && !item.verified && !(item.provenance?.kind === "manual" && !item.provenance.reason?.trim());
  const label = `${item.title} · ${occurrenceTimeRange(item)} · ${source}${review ? ` · ${deadlineReviewLabel(item)}` : ""}`;
  return <Button variant="ghost" aria-label={label} title={label} onClick={onOpen}
    style={{ ...color.style, ...style, height }} className={cn("absolute z-[1] flex min-w-0 flex-col items-stretch justify-start gap-0 overflow-hidden rounded-[4px] border py-0.5 ps-2 pe-1 text-left whitespace-normal", color.card, color.accent, isCompleted(item) && "opacity-60")}>
    <span aria-hidden="true" className={cn("absolute inset-y-0 start-0 w-0.5 bg-current", color.marker)} />
    <span className={cn("block text-[11px] leading-[13px] font-medium text-foreground", height >= 50 ? "line-clamp-2" : "truncate", isCompleted(item) && "line-through")}>{item.kind === "deadline" && <Timer className="me-1 inline size-2.5" />}{review && <span className="me-1 text-amber-11">!</span>}{item.title}</span>
    {height >= 32 && <span className={cn("mt-0.5 block truncate text-[9px] leading-[11px] tabular-nums", color.accent)}>{occurrenceTimeRange(item)}</span>}
    {height >= 76 && <span className="mt-1 block truncate text-[9px] leading-3 text-muted-foreground">{source}</span>}
  </Button>;
}
