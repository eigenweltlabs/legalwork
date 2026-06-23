/** @jsxImportSource react */

/**
 * Learnings main pane. Rendered inside the session shell's `SidebarInset`
 * (via SessionPage's `mainView`), so the main app sidebar stays in place.
 * Intentionally empty for now — just the title centered.
 */
export function LearningsPane() {
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-[12%] -top-[20%] h-[60%] w-[60%] rounded-full bg-[radial-gradient(ellipse,rgba(35,82,222,0.07),transparent_70%)] blur-3xl" />
        <div className="absolute -bottom-[18%] -right-[8%] h-[50%] w-[50%] rounded-full bg-[radial-gradient(ellipse,rgba(134,105,185,0.06),transparent_70%)] blur-3xl" />
      </div>
      <div className="relative z-10 flex flex-col items-center gap-2 text-center">
        <span className="lw-section-eyebrow">Learnings</span>
        <h1 className="text-4xl font-medium tracking-[-0.04em] text-foreground">Learnings</h1>
      </div>
    </div>
  );
}
