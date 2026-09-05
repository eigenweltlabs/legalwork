import { useId } from "react"

export type TaskIllustrationKind = "grid" | "redline" | "summary"

/** Small native illustrations stay crisp at every desktop scale. */
export function TaskIllustration({ kind }: { kind: TaskIllustrationKind }) {
  const gradientId = useId()

  return (
    <svg aria-hidden="true" viewBox="0 0 80 64" fill="none" className="lw-task-illustration" data-illustration-kind={kind}>
      <defs>
        <linearGradient id={gradientId} x1="24" y1="8" x2="55" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--lw-surface)" />
          <stop offset="1" stopColor="color-mix(in srgb, var(--lw-illustration-accent) 10%, var(--lw-surface))" />
        </linearGradient>
      </defs>
      <rect x="24" y="7" width="38" height="46" rx="6" transform="rotate(9 24 7)" fill="var(--lw-sunken)" stroke="var(--lw-border)" />
      <rect x="17" y="10" width="39" height="47" rx="6" transform="rotate(-7 17 10)" fill="var(--lw-surface)" stroke="var(--lw-border)" />
      <rect x="21.5" y="9.5" width="39" height="48" rx="5.5" fill={`url(#${gradientId})`} stroke="var(--lw-border-strong)" />
      <path d="M29 18H43" stroke="var(--lw-illustration-accent)" strokeWidth="2" strokeLinecap="round" />
      {kind === "grid" ? (
        <>
          <rect x="28.5" y="25.5" width="25" height="24" rx="2.5" fill="var(--lw-surface)" stroke="var(--lw-border-strong)" />
          <path d="M29 32H53M29 40H53M37 26V49M45 26V49" stroke="var(--lw-border-strong)" />
          <rect x="29" y="26" width="24" height="6" rx="2" fill="var(--lw-illustration-accent)" opacity=".16" />
          <path d="m47 43 1.5 1.5 2.5-3" stroke="var(--lw-illustration-accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : kind === "redline" ? (
        <>
          <path d="M29 27H52M29 33H46M29 45H42" stroke="var(--lw-border-strong)" strokeWidth="2" strokeLinecap="round" />
          <rect x="27" y="36" width="28" height="6" rx="2" fill="var(--lw-illustration-accent)" opacity=".18" />
          <path d="M30 39H49" stroke="var(--lw-illustration-accent)" strokeWidth="1.2" strokeLinecap="round" />
          <path d="m48 51 3.5-.8L65 36.7l-2.7-2.8L49 47.5 48 51Z" fill="var(--lw-surface)" stroke="var(--lw-illustration-accent)" strokeLinejoin="round" />
          <path d="m59.5 37 2.7 2.8" stroke="var(--lw-illustration-accent)" />
        </>
      ) : (
        <>
          <path d="M29 27H51M29 32H48M29 37H43" stroke="var(--lw-border-strong)" strokeWidth="2" strokeLinecap="round" />
          <rect x="35" y="41" width="32" height="15" rx="5" fill="var(--lw-surface)" stroke="var(--lw-border-strong)" />
          <path d="M42 47H60M42 51H54" stroke="var(--lw-illustration-accent)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}
