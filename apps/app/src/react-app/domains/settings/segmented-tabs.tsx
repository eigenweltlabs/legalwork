/** @jsxImportSource react */
/**
 * The app's canonical hub tab bar — the "Connectors / Skills / Plugins" pill
 * segmented control used on the Integrations page. Shared so every hub (and
 * Settings > Recorder) renders the exact same control and they can't drift.
 */
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export const segmentedTrackClass = "flex w-fit max-w-full flex-wrap gap-0.5 rounded-full bg-dls-hover p-1";
export const segmentedItemClass =
  "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&_svg]:shrink-0";
export const segmentedActiveClass = "bg-dls-surface text-dls-text shadow-[0_1px_2px_rgba(8,23,79,0.08)]";
export const segmentedInactiveClass = "text-dls-secondary hover:text-dls-text";

export type HubTab<T extends string> = { id: T; label: string; icon?: LucideIcon };

export function HubTabs<T extends string>(props: {
  items: ReadonlyArray<HubTab<T>>;
  value: T;
  onChange: (id: T) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div role="group" aria-label={props.label} className={cn(segmentedTrackClass, props.className)}>
      {props.items.map(({ id, label, icon: Icon }) => {
        const active = props.value === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => props.onChange(id)}
            className={`${segmentedItemClass} ${active ? segmentedActiveClass : segmentedInactiveClass}`}
          >
            {Icon ? <Icon size={14} strokeWidth={1.75} /> : null}
            {label}
          </button>
        );
      })}
    </div>
  );
}
