import { CalendarDays, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { calendarDisplayColor } from "./calendar-colors";
import { cn } from "@/lib/utils";
import type { ConnectedCalendar } from "./connected-calendars";
export { ConnectedCalendarEventDialog } from "./connected-calendar-event-dialog";

export function ConnectedCalendarControls({ calendars, hidden, loading, disabled, onVisible }: {
  calendars: ConnectedCalendar[]; hidden: string[]; loading: boolean; disabled: boolean; onVisible: (key: string, visible: boolean) => void;
}) {
  const visibleCount = calendars.filter(calendar => !hidden.includes(calendar.key)).length;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className={cn("h-7 min-w-0 max-w-full gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs font-normal text-foreground hover:bg-muted/60", visibleCount < calendars.length && "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15")} disabled={disabled} />}>
      {loading ? <Loader2 aria-hidden className="size-3.5 animate-spin text-muted-foreground" /> : <CalendarDays aria-hidden className="size-3.5 text-muted-foreground" />}
      <span className="min-w-0 truncate">{t("calendar.connected_calendars")}</span>{calendars.length > 0 && <span className="text-muted-foreground">{visibleCount}/{calendars.length}</span>}
      <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-96 max-w-[calc(100vw-2rem)]">
      {!calendars.length && <p className="px-3 py-2 text-sm text-muted-foreground">{t(loading ? "calendar.loading" : "calendar.connected_empty")}</p>}
      {calendars.map(calendar => {
        const color = calendarDisplayColor(calendar.key, calendar.color);
        return <DropdownMenuCheckboxItem key={calendar.key} checked={!hidden.includes(calendar.key)} closeOnClick={false} onCheckedChange={visible => onVisible(calendar.key, visible)}>
          <span aria-hidden style={color.style} className={cn("size-2 shrink-0 rounded-full bg-current ring-1 ring-inset ring-border/50", color.marker)} />
          <span className="min-w-0 flex-1 truncate" title={calendar.name}>{calendar.name || calendar.providerName}</span>
          <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">{calendar.providerName}</span>
        </DropdownMenuCheckboxItem>;
      })}
    </DropdownMenuContent>
  </DropdownMenu>;
}
