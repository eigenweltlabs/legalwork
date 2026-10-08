import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { CalendarClock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatTaskDueDate, taskDueDateInputValue, taskDueTone } from "./task-format";
import { OptionText } from "./task-glyphs";

/** Status, assignee and priority as chips: the current value with its mark, a menu behind it. */
export type PropertyChipItem = {
  value: string;
  /** What the chip shows once chosen. */
  label: string;
  leading: ReactNode;
  /** The menu's line when it differs from the chip's (defaults to `label`). */
  primary?: string;
  /** A second, muted line in the menu, e.g. a member's email. */
  detail?: string;
  /** A key that picks the entry while the menu is open, shown at its end. */
  key?: string;
};

const CHIP_CLASS =
  "h-8 w-fit min-w-0 max-w-full gap-2 rounded-lg border-border/70 bg-background px-2.5 text-xs font-medium text-foreground shadow-xs hover:bg-muted/50 data-[size=sm]:h-8 [&>svg]:text-muted-foreground";

export function PropertyChip(props: {
  label: string;
  value: string;
  items: PropertyChipItem[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const current = props.items.find((item) => item.value === props.value);
  // Open state is held here so a key shortcut can close the menu after picking.
  const [open, setOpen] = useState(false);
  const pickByKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const item = props.items.find((entry) => entry.key === event.key);
    if (!item) return;
    event.preventDefault();
    props.onChange(item.value);
    setOpen(false);
  };
  return (
    <Select
      value={props.value}
      items={props.items}
      disabled={props.disabled}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(value) => props.onChange(value ?? "")}
    >
      <SelectTrigger size="sm" aria-label={props.label} className={CHIP_CLASS}>
        {current?.leading}
        <SelectValue className="min-w-0" title={current?.label}>
          <span className="truncate">{current?.label}</span>
        </SelectValue>
      </SelectTrigger>
      {/* As wide as the entries need rather than as the chip: the chip shows
          one short value, the menu has to show every name in full. */}
      <SelectContent align="start" className="w-auto min-w-(--anchor-width) max-w-80" onKeyDown={pickByKey}>
        <SelectGroup>
          {props.items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.leading}
              <OptionText primary={item.primary ?? item.label} detail={item.detail} />
              {item.key ? (
                <span aria-hidden className="ms-auto ps-5 text-[11px] font-normal tabular-nums text-muted-foreground">
                  {item.key}
                </span>
              ) : null}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/**
 * The due date as a chip around a native date input: the platform's own
 * picker, no library, and a clear button once a date is set. A date-only
 * deadline is the firm's local day; the server stores it as local midnight.
 */
export function DueDateChip(props: { value: string | null; disabled: boolean; onChange: (day: string | null) => void }) {
  const id = useId();
  const tone = taskDueTone(props.value);
  return (
    <span
      className={cn(
        "inline-flex h-8 min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-background ps-2.5 pe-1 text-xs font-medium shadow-xs",
        tone === "overdue" && "text-red-9",
        tone === "today" && "text-amber-11",
      )}
    >
      <label htmlFor={id} className="sr-only">
        {t("tasks.field_due")}
      </label>
      <CalendarClock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        id={id}
        type="date"
        disabled={props.disabled}
        value={taskDueDateInputValue(props.value)}
        title={props.value ? t("tasks.due_label", { date: formatTaskDueDate(props.value) }) : t("tasks.due_none")}
        className="h-8 min-w-0 bg-transparent text-xs font-medium text-inherit outline-none disabled:cursor-not-allowed"
        onChange={(event) => props.onChange(event.target.value || null)}
      />
      {props.value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("tasks.due_clear")}
          disabled={props.disabled}
          onClick={() => props.onChange(null)}
        >
          <X />
        </Button>
      ) : null}
    </span>
  );
}
