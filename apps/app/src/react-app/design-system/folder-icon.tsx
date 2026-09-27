import { useId, type ComponentProps } from "react";

import { cn } from "@/lib/utils";

export type FolderIconProps = Omit<ComponentProps<"svg">, "children"> & {
  open?: boolean;
  /** Shared with others: two people on its front. */
  shared?: boolean;
};

/** A light-blue folder asset, drawn in layers so it stays crisp at any density. */
export function FolderIcon({ open = false, shared = false, className, ...props }: FolderIconProps) {
  const id = useId();

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("lw-folder-icon size-5 shrink-0", className)}
      {...props}
    >
      <defs>
        <linearGradient id={`${id}-back`} x1="12" y1="4" x2="12" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--lw-asset-front)" />
          <stop offset="1" stopColor="var(--lw-asset-back)" />
        </linearGradient>
        <linearGradient id={`${id}-front`} x1="12" y1="9" x2="12" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--lw-surface)" />
          <stop offset="1" stopColor="var(--lw-asset-front)" />
        </linearGradient>
      </defs>
      <path
        d="M3 7a2 2 0 0 1 2-2h4.1a2 2 0 0 1 1.4.6L12 7h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        fill={`url(#${id}-back)`}
        stroke="var(--lw-asset-edge)"
        strokeWidth=".8"
      />
      <path d="M5 9.5h14v7H5z" fill="var(--lw-surface)" />
      <path
        className="lw-folder-face"
        d={open
          ? "M5.3 10h15.4a1 1 0 0 1 1 1.2L20.2 18a2.5 2.5 0 0 1-2.4 2H5.4a1.5 1.5 0 0 1-1.5-1.8L5.3 10Z"
          : "M3 10h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Z"}
        fill={`url(#${id}-front)`}
        stroke="var(--lw-asset-edge)"
        strokeWidth=".8"
        strokeLinejoin="round"
      />
      <path d={open ? "M6 11h14.4" : "M4 11h16"} stroke="var(--lw-glass-highlight)" strokeLinecap="round" />
      {shared ? (
        <g fill="var(--lw-asset-edge)">
          <circle cx="14.6" cy="12.9" r="1.3" />
          <path d="M12.5 18.7a2.3 3.4 0 0 1 4.6 0z" />
          {/* The front person, edged in the folder's colour so the two stay apart. */}
          <g stroke="var(--lw-surface)" strokeWidth="0.9" paintOrder="stroke">
            <circle cx="10.9" cy="13.6" r="1.65" />
            <path d="M8.1 18.7a2.8 3 0 0 1 5.6 0z" />
          </g>
        </g>
      ) : null}
    </svg>
  );
}
