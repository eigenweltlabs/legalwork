import { cn } from "../utils/cn";

/** Keyboard shortcut hint, e.g. <Kbd>⌘</Kbd><Kbd>P</Kbd>. */
export function Kbd({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-[1.25rem] items-center justify-center rounded-md px-1 py-0.5",
        "font-sans text-2xs font-medium text-tertiary",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
