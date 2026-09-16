/** @jsxImportSource react */
/**
 * The small marks the Tasks pane repeats: a status glyph whose shape carries
 * the state (colour is never the only cue), a priority mark, an initials mark
 * for the assignee, and the sync mark that says where a task stands against
 * the firm's account.
 */
import { Circle, CircleCheck, CircleDashed, CircleDotDashed, CircleSlash, CloudOff } from "lucide-react";

import type { LegalworkTaskPriority, LegalworkTaskStatus, LegalworkTaskSync } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { taskPriorityLabel } from "./task-format";

const STATUS_GLYPHS = {
  open: { Icon: Circle, tone: "text-muted-foreground" },
  in_progress: { Icon: CircleDotDashed, tone: "text-foreground" },
  done: { Icon: CircleCheck, tone: "text-[var(--lw-success)]" },
  cancelled: { Icon: CircleSlash, tone: "text-muted-foreground/70" },
} as const;

export function StatusGlyph(props: { status: LegalworkTaskStatus; className?: string }) {
  const { Icon, tone } = STATUS_GLYPHS[props.status];
  return <Icon aria-hidden strokeWidth={1.75} className={cn("size-3.5 shrink-0", tone, props.className)} />;
}

/** Three rising bars, bottom-aligned; the priority decides how many are lit. */
const PRIORITY_BARS = [
  { x: 1.5, y: 8.5, height: 6 },
  { x: 6.5, y: 5, height: 9.5 },
  { x: 11.5, y: 1.5, height: 13 },
];

/**
 * The priority as Linear draws it, so it reads the same in both tools: bars
 * lit from the left as the priority climbs (low 1, medium 2, high 3), a
 * filled square with a "!" for urgent, and three dashes for no priority.
 * Neutral ink; the shape carries the level, never a colour.
 */
export function PriorityMark(props: { priority: LegalworkTaskPriority; className?: string }) {
  const label = t("tasks.priority_aria", { priority: taskPriorityLabel(props.priority) });
  const className = cn("size-3.5 shrink-0", props.priority === 0 ? "text-muted-foreground" : "text-foreground", props.className);
  if (props.priority === 1) {
    return (
      <svg viewBox="0 0 16 16" role="img" aria-label={label} className={className}>
        <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
        <path d="M8 4.25v4.5" stroke="var(--background)" strokeWidth="1.9" strokeLinecap="round" />
        <circle cx="8" cy="11.6" r="1.1" fill="var(--background)" />
      </svg>
    );
  }
  if (props.priority === 0) {
    return (
      <svg viewBox="0 0 16 16" role="img" aria-label={label} className={className}>
        {PRIORITY_BARS.map((bar) => (
          <rect key={bar.x} x={bar.x} y="7.25" width="3" height="1.5" rx="0.75" fill="currentColor" />
        ))}
      </svg>
    );
  }
  const lit = props.priority === 2 ? 3 : props.priority === 3 ? 2 : 1;
  return (
    <svg viewBox="0 0 16 16" role="img" aria-label={label} className={className}>
      {PRIORITY_BARS.map((bar, index) => (
        <rect key={bar.x} x={bar.x} y={bar.y} width="3" height={bar.height} rx="1" fill="currentColor" opacity={index < lit ? 1 : 0.3} />
      ))}
    </svg>
  );
}

/**
 * A priority as a picker offers it: its mark, its name, and — pushed to the
 * end, like Linear — the digit that picks it while the menu is open.
 */
export function PriorityOption(props: { priority: LegalworkTaskPriority }) {
  return (
    <>
      <PriorityMark priority={props.priority} />
      <span className="truncate">{taskPriorityLabel(props.priority)}</span>
      <span aria-hidden className="ms-auto ps-4 text-xs tabular-nums text-muted-foreground">
        {props.priority}
      </span>
    </>
  );
}

/** "Anna Schmidt" -> "AS"; a bare address -> its first two letters. */
export function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return "?";
  const last = words.length > 1 ? words[words.length - 1] : null;
  return (last ? `${first[0]}${last[0]}` : first.slice(0, 2)).toUpperCase();
}

/**
 * A picker entry's text: one truncated line, and an optional muted second line
 * (a member's email). Truncating inside the item keeps long names out from
 * under the selection check.
 */
export function OptionText(props: { primary: string; detail?: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="max-w-60 truncate">{props.primary}</span>
      {props.detail ? (
        <span className="max-w-60 truncate text-xs font-normal text-muted-foreground">{props.detail}</span>
      ) : null}
    </span>
  );
}

/** Neutral initials mark; a dashed circle stands for "nobody yet". */
export function AssigneeMark(props: { name: string | null; className?: string }) {
  if (!props.name) {
    return <CircleDashed aria-hidden strokeWidth={1.5} className={cn("size-4 shrink-0 text-muted-foreground/70", props.className)} />;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[9px] font-semibold leading-none text-foreground/80",
        props.className,
      )}
    >
      {initialsOf(props.name)}
    </span>
  );
}

/**
 * Syncing is nobody's business until it fails: the mark appears only when a
 * change of this task could not be pushed, never for "waiting" or "synced".
 */
export function SyncMark(props: { sync: LegalworkTaskSync; className?: string }) {
  if (!props.sync.error) return null;
  return <CloudOff aria-label={t("tasks.sync_unavailable")} strokeWidth={1.75} className={cn("size-3 shrink-0 text-muted-foreground", props.className)} />;
}
