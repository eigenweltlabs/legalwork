import type { LucideIcon } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** The compact filter control shared by Tasks and Calendar. */
export function FilterSelect(props: {
  icon: LucideIcon;
  compact?: boolean;
  active?: boolean;
  label: string;
  value: string;
  options: { value: string; label: string; primary?: string; detail?: string }[];
  onChange: (value: string) => void;
}) {
  const Icon = props.icon;
  return <Select value={props.value} items={props.options} onValueChange={value => { if (value !== null) props.onChange(value); }}>
    <SelectTrigger size="sm" aria-label={props.label} title={props.options.find(option => option.value === props.value)?.label}
      className={cn("h-7 min-w-0 max-w-full gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs text-foreground hover:bg-muted/60 data-[size=sm]:h-7", props.active && "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15")}>
      <Icon aria-hidden className="size-3.5 text-muted-foreground" />
      <SelectValue className={props.compact ? "sr-only" : "min-w-0 max-w-48 truncate"} />
    </SelectTrigger>
    <SelectContent align="start" className="w-auto min-w-(--anchor-width) max-w-80">
      <SelectGroup>{props.options.map(option => <SelectItem key={option.value} value={option.value}>
        <span className="flex min-w-0 flex-col"><span className="max-w-60 truncate">{option.primary ?? option.label}</span>{option.detail && <span className="max-w-60 truncate text-xs font-normal text-muted-foreground">{option.detail}</span>}</span>
      </SelectItem>)}</SelectGroup>
    </SelectContent>
  </Select>;
}
