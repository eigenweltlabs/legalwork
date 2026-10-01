import { useId } from "react"

export type TaskIllustrationKind = "grid" | "redline" | "summary"

/** Miniature task previews stay crisp at every desktop scale. */
export function TaskIllustration({ kind }: { kind: TaskIllustrationKind }) {
  const shadowId = useId()

  return (
    <svg aria-hidden="true" viewBox="0 0 160 96" fill="none" className="lw-task-illustration size-auto">
      <defs>
        <filter id={shadowId} x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="var(--lw-illustration-accent)" floodOpacity=".12" />
        </filter>
      </defs>
      {kind === "grid" ? (
        <g filter={`url(#${shadowId})`}>
          <rect x="19" y="14" width="118" height="68" rx="7" fill="var(--lw-surface)" stroke="var(--lw-border-strong)" />
          <path d="M29 24H51" stroke="var(--lw-illustration-accent)" strokeWidth="3" strokeLinecap="round" />
          <circle cx="125" cy="24" r="2" fill="var(--lw-border-strong)" />
          <rect x="26" y="33" width="104" height="41" rx="3" stroke="var(--lw-border)" />
          <rect x="26" y="33" width="104" height="11" rx="3" fill="var(--lw-illustration-accent)" opacity=".14" />
          <path d="M26 44H130M26 54H130M26 64H130M61 33V74M96 33V74" stroke="var(--lw-border)" />
          <path d="M33 39H49M68 39H83M103 39H119" stroke="var(--lw-illustration-accent)" strokeWidth="2" strokeLinecap="round" opacity=".6" />
          <path d="M33 49H48M33 59H51M33 69H45M68 49H85M103 59H118M68 69H80" stroke="var(--lw-border-strong)" strokeWidth="2" strokeLinecap="round" />
          <rect x="66" y="56" width="24" height="6" rx="2" fill="var(--lw-illustration-accent)" opacity=".2" />
          <circle cx="125" cy="75" r="10" fill="var(--lw-illustration-accent)" />
          <path d="m121 75 2.5 2.5 5-5" stroke="var(--lw-surface)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ) : kind === "redline" ? (
        <g filter={`url(#${shadowId})`}>
          <rect x="39" y="10" width="69" height="76" rx="6" transform="rotate(-5 39 10)" fill="var(--lw-surface)" stroke="var(--lw-border)" />
          <rect x="45" y="8" width="69" height="76" rx="6" fill="var(--lw-surface)" stroke="var(--lw-border-strong)" />
          <path d="M55 19H81" stroke="var(--lw-illustration-accent)" strokeWidth="3" strokeLinecap="round" />
          <path d="M55 29H103M55 35H95M55 68H75M55 74H88" stroke="var(--lw-border-strong)" strokeWidth="2" strokeLinecap="round" />
          <rect x="52" y="41" width="40" height="8" rx="2" fill="var(--lw-file-pdf)" opacity=".12" />
          <path d="M55 45H89" stroke="var(--lw-file-pdf)" strokeWidth="1.5" strokeLinecap="round" />
          <rect x="52" y="53" width="53" height="8" rx="2" fill="var(--lw-illustration-accent)" opacity=".15" />
          <path d="M55 57H100" stroke="var(--lw-illustration-accent)" strokeWidth="1.5" strokeLinecap="round" />
          <g transform="rotate(8 120 60)">
            <rect x="115" y="34" width="8" height="39" rx="2" fill="var(--lw-surface)" stroke="var(--lw-illustration-accent)" strokeWidth="1.5" />
            <path d="m115 73 4 7 4-7M115 42H123M119 43V71" stroke="var(--lw-illustration-accent)" strokeWidth="1.5" strokeLinejoin="round" />
          </g>
        </g>
      ) : (
        <g filter={`url(#${shadowId})`}>
          <rect x="27" y="16" width="52" height="64" rx="5" transform="rotate(-8 27 16)" fill="var(--lw-surface)" stroke="var(--lw-border)" />
          <rect x="36" y="11" width="52" height="64" rx="5" fill="var(--lw-surface)" stroke="var(--lw-border-strong)" />
          <path d="M46 22H68" stroke="var(--lw-illustration-accent)" strokeWidth="3" strokeLinecap="round" />
          <path d="M46 33H77M46 40H73M46 47H77M46 54H66M46 61H71" stroke="var(--lw-border-strong)" strokeWidth="2" strokeLinecap="round" />
          <rect x="68" y="30" width="66" height="54" rx="7" fill="var(--lw-surface)" stroke="var(--lw-border-strong)" />
          <rect x="77" y="39" width="26" height="4" rx="2" fill="var(--lw-illustration-accent)" opacity=".75" />
          {[53, 63, 73].map((y, index) => (
            <g key={y}>
              <circle cx="79" cy={y} r="2" fill="var(--lw-illustration-accent)" />
              <path d={`M86 ${y}H${index === 1 ? 113 : 123}`} stroke="var(--lw-border-strong)" strokeWidth="2" strokeLinecap="round" />
            </g>
          ))}
        </g>
      )}
    </svg>
  )
}
