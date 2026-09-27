/** @jsxImportSource react */
/**
 * Shared centered shell for the full-screen onboarding steps.
 */
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Page, PageTitlebarRegion } from "@/components/page";

/** Tiny progress dots shown above a step's heading — the active step is a
 * wider pill so users always know where they are in the flow. */
export function StepDots(props: { step: number; total: number }) {
  return (
    <div className="mb-6 flex items-center gap-1.5">
      {Array.from({ length: props.total }, (_, index) => (
        <span
          key={index}
          className={
            index + 1 === props.step
              ? "h-1.5 w-5 rounded-full bg-primary"
              : index + 1 < props.step
                ? "size-1.5 rounded-full bg-primary/40"
                : "size-1.5 rounded-full bg-dls-border"
          }
        />
      ))}
    </div>
  );
}

/** Wizard footer back button — bottom-left of the centered column. */
export function CoverBackButton(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 text-[13px] text-dls-secondary transition-colors hover:text-dls-text"
      onClick={props.onClick}
    >
      <ArrowLeft className="size-3.5" />
      {props.label}
    </button>
  );
}

/** Wizard footer skip/continue — bottom-right of the centered column. */
export function CoverSkipButton(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="text-[13px] text-dls-secondary transition-colors hover:text-dls-text"
      onClick={props.onClick}
    >
      {props.label}
    </button>
  );
}

/** Dev/design affordance: localStorage["legalwork.onboardingDemo"] = "1"
 * makes the tool steps simulate their states (detected Office apps, mic
 * grant, model download) so every screen can be reviewed on any machine. */
export function onboardingDemoActive(): boolean {
  try {
    if (import.meta.env.DEV && window.location.pathname === "/onboarding-preview.html") return true;
    return window.localStorage.getItem("legalwork.onboardingDemo") === "1";
  } catch {
    return false;
  }
}

export function OnboardingCover(props: {
  children: ReactNode;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
}) {
  const hasFooter = Boolean(props.footerLeft || props.footerRight);
  return (
    <Page className="fixed inset-0 z-40 h-dvh overflow-y-auto bg-background">
      <PageTitlebarRegion />
      <div className="mx-auto flex min-h-full w-full max-w-[448px] flex-col px-6 pb-6 pt-12 sm:pb-8">
        <main className="flex flex-1 flex-col justify-center py-12">{props.children}</main>
        {hasFooter ? (
          <footer className="flex min-h-9 flex-wrap items-center justify-between gap-4">
            <div>{props.footerLeft}</div>
            <div>{props.footerRight}</div>
          </footer>
        ) : null}
      </div>
    </Page>
  );
}
