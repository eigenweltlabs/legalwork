import { CalendarDays, CircleCheck, Repeat2, SquareCheck, Timer } from "lucide-react";
import { useCallback, useRef, type AriaAttributes, type CSSProperties, type ReactNode } from "react";
import type { CalendarDisplayOccurrence } from "./connected-calendars";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { deadlineReviewLabel, calendarKindLabel, isCompleted, occurrenceTime, occurrenceTimeRange } from "./calendar-format";
import { calendarDisplayColor, type CalendarColor } from "./calendar-colors";

export type CalendarEntryAppearance = {
  colorKey?: string | null;
  color?: CalendarColor;
  secondaryLabel?: string;
  groupLabel?: string;
  sourceLabel?: string;
  sourceIcon?: ReactNode;
  durationLabel?: string;
  buttonAttributes?: AriaAttributes & { [key: `data-${string}`]: string | boolean | undefined };
  onFocusedRemoval?: (element: HTMLButtonElement) => void;
  actions?: ReactNode;
};

function useCalendarButtonRef(onFocusedRemoval: CalendarEntryAppearance["onFocusedRemoval"]) {
  const button = useRef<HTMLButtonElement>(null), removed = useRef(onFocusedRemoval);
  removed.current = onFocusedRemoval;
  return useCallback((element: HTMLButtonElement | null) => {
    if (!element && button.current && button.current.ownerDocument.activeElement === button.current)
      removed.current?.(button.current);
    button.current = element;
  }, []);
}

function CalendarEntryActions({ children }: { children: ReactNode }) {
  return <div className="absolute end-0.5 top-1/2 z-[1] flex -translate-y-1/2">{children}</div>;
}

function CalendarWorkContent({ item, appearance }: { item: CalendarDisplayOccurrence; appearance: CalendarEntryAppearance }) {
  return <span className={cn("flex w-full min-w-0 flex-col gap-1 text-left", appearance.actions && "pe-14")}>
    <span className="flex min-w-0 items-center gap-1.5">
      <Badge variant="secondary" title={appearance.groupLabel} className="h-4 max-w-[40%] rounded-md bg-background/70 px-1.5 py-0 text-[10px] leading-4 text-foreground">
        <span className="truncate">{appearance.groupLabel}</span>
      </Badge>
      <span className="min-w-0 truncate text-[11px] leading-4 font-medium text-foreground">{item.title}</span>
    </span>
    <span className="flex min-w-0 items-center gap-1 text-[9px] leading-3 text-muted-foreground">
      {appearance.sourceIcon}
      <span className="min-w-0 truncate">{appearance.sourceLabel}</span>
      {(appearance.durationLabel || !item.allDay) && <span className="ms-auto shrink-0 tabular-nums">{appearance.durationLabel ?? occurrenceTimeRange(item)}</span>}
    </span>
  </span>;
}

export function CalendarEntry({ item, projectId = item.projectId, compact, showProject, appearance, onOpen }: {
  item: CalendarDisplayOccurrence; projectId?: string | null; compact?: boolean; showProject?: boolean;
  appearance?: CalendarEntryAppearance; onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const bindButton = useCalendarButtonRef(appearance?.onFocusedRemoval);
  const Icon = item.kind === "deadline" ? Timer : item.kind === "task" ? SquareCheck : CalendarDays;
  const color = appearance?.color ?? calendarDisplayColor(item.connectedEvent?.calendar.key ??
    (appearance?.colorKey === undefined ? projectId ?? item.itemId : appearance.colorKey), item.connectedEvent?.calendar.color);
  const showReview = item.kind === "deadline" && !item.verified && !(item.provenance?.kind === "manual" && !item.provenance.reason?.trim());
  const showMeta = item.recurring || showReview || isCompleted(item);
  const source = item.connectedEvent ? `${item.connectedEvent.calendar.providerName} · ${item.connectedEvent.calendar.name}` : item.projectName;
  const label = appearance?.secondaryLabel ? `${item.title} · ${appearance.secondaryLabel}` : undefined;
  if (compact) {
    const button = <Button {...appearance?.buttonAttributes} ref={appearance?.onFocusedRemoval ? bindButton : undefined} variant="ghost" style={color.style}
    onClick={event => onOpen(event.currentTarget)} aria-label={label} title={label ?? `${item.title} · ${source} · ${occurrenceTimeRange(item)}`}
    className={cn("flex h-5 w-full min-w-0 justify-start gap-1 overflow-hidden rounded-sm px-1.5 py-0 text-[10px] font-normal text-foreground aria-expanded:ring-1 aria-expanded:ring-inset aria-expanded:ring-ring", item.allDay ? cn("border", color.card) : "hover:bg-muted/60", isCompleted(item) && "opacity-60", appearance?.actions && !appearance.groupLabel && "h-7 pe-14", appearance?.groupLabel && "h-auto min-h-11 items-stretch py-1 whitespace-normal")}>
    {appearance?.groupLabel ? <CalendarWorkContent item={item} appearance={appearance} /> : <>
    <span aria-label={calendarKindLabel(item.kind)} className={cn("flex size-2 shrink-0 items-center justify-center", color.marker)}>{item.kind === "deadline" || item.kind === "task" ? <Icon className="size-2.5" /> : <span className="size-1.5 rounded-full bg-current ring-1 ring-inset ring-border/50" />}</span>
    {!item.allDay && <span className="shrink-0 text-[9px] text-muted-foreground tabular-nums">{occurrenceTime(item)}</span>}
    <span className={cn("min-w-0 truncate font-medium", isCompleted(item) && "line-through")}>{item.title}</span>
    {appearance?.secondaryLabel && <span className="ms-auto max-w-[50%] shrink-0 truncate text-[9px] text-muted-foreground">{appearance.secondaryLabel}</span>}
    {showReview && <span className="ms-auto shrink-0" title={deadlineReviewLabel(item)}>!</span>}
    </>}
  </Button>;
    return appearance?.actions ? <div className="relative">{button}<CalendarEntryActions>{appearance.actions}</CalendarEntryActions></div> : button;
  }
  return <Button variant="ghost" style={color.style} onClick={event => onOpen(event.currentTarget)} title={`${item.title} · ${source} · ${occurrenceTimeRange(item)}`}
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

export function CalendarTimeBlock({ item, projectId = item.projectId, height, style, appearance, onOpen }: {
  item: CalendarDisplayOccurrence; projectId?: string | null; height: number; style: CSSProperties;
  appearance?: CalendarEntryAppearance; onOpen: (trigger: HTMLButtonElement) => void;
}) {
  const bindButton = useCalendarButtonRef(appearance?.onFocusedRemoval);
  const color = appearance?.color ?? calendarDisplayColor(item.connectedEvent?.calendar.key ??
    (appearance?.colorKey === undefined ? projectId ?? item.itemId : appearance.colorKey), item.connectedEvent?.calendar.color);
  const source = item.connectedEvent ? `${item.connectedEvent.calendar.providerName} · ${item.connectedEvent.calendar.name}` : item.projectName;
  const review = item.kind === "deadline" && !item.verified && !(item.provenance?.kind === "manual" && !item.provenance.reason?.trim());
  const label = `${item.title} · ${occurrenceTimeRange(item)} · ${source}${appearance?.sourceLabel ? " · " + appearance.sourceLabel : ""}${review ? ` · ${deadlineReviewLabel(item)}` : ""}`;
  const title = <span className={cn("block min-w-0 text-[11px] leading-[13px] font-medium text-foreground", height >= 50 ? "line-clamp-2" : "truncate", isCompleted(item) && "line-through")}>{item.kind === "deadline" && <Timer className="me-1 inline size-2.5" />}{review && <span className="me-1 text-amber-11">!</span>}{item.title}</span>;
  const button = <Button {...appearance?.buttonAttributes} ref={appearance?.onFocusedRemoval ? bindButton : undefined} variant="ghost" aria-label={label} title={label} onClick={event => onOpen(event.currentTarget)}
    style={appearance?.actions ? color.style : { ...color.style, ...style, height }} className={cn("absolute z-[1] flex min-w-0 flex-col items-stretch justify-start gap-0 overflow-hidden rounded-[4px] border py-0.5 ps-2 pe-1 text-left whitespace-normal aria-expanded:ring-1 aria-expanded:ring-inset aria-expanded:ring-ring", color.card, color.accent, isCompleted(item) && "opacity-60", appearance?.actions && "inset-0 size-full", appearance?.actions && !appearance.groupLabel && "pe-14")}>
    <span aria-hidden="true" className={cn("absolute inset-y-0 start-0 w-0.5 bg-current", color.marker)} />
    {appearance?.groupLabel ? <CalendarWorkContent item={item} appearance={appearance} /> : <>{appearance?.secondaryLabel ? <span className="flex min-w-0 gap-1">
      <span className="max-w-[45%] shrink-0 truncate text-[9px] leading-[13px] text-muted-foreground">{appearance.secondaryLabel}</span>
      {title}
    </span> : title}
    {height >= 32 && <span className={cn("mt-0.5 block truncate text-[9px] leading-[11px] tabular-nums", color.accent)}>{occurrenceTimeRange(item)}</span>}
    {height >= 76 && !appearance?.secondaryLabel && <span className="mt-1 block truncate text-[9px] leading-3 text-muted-foreground">{source}</span>}</>}
  </Button>;
  return appearance?.actions ? <div className="absolute z-[1] rounded-[4px] bg-background" style={{ ...style, height }}>
    {button}<CalendarEntryActions>{appearance.actions}</CalendarEntryActions>
  </div> : button;
}
