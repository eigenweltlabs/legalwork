import { cn } from "../utils/cn";

export interface DividerProps {
  /** Horizontal (default) or vertical. */
  orientation?: "horizontal" | "vertical";
  /** Indent the line to align under a row's text (skips the leading gutter). */
  inset?: boolean;
  className?: string;
}

/** Hairline separator. Use `inset` between grouped rows inside a Card. */
export function Divider({ orientation = "horizontal", inset, className }: DividerProps) {
  if (orientation === "vertical") {
    return <span role="separator" aria-orientation="vertical" className={cn("w-px self-stretch bg-subtle", className)} />;
  }
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={cn("h-px bg-subtle", inset ? "ml-4" : "", className)}
    />
  );
}
