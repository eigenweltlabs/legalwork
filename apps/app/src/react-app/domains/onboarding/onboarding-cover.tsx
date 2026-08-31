/** @jsxImportSource react */
/**
 * Shared shell for the full-screen onboarding covers: left action column,
 * right dark grained panel. Every step used to re-implement this layout;
 * keep the chrome here and the steps down to their content.
 */
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { PaperGrainGradient } from "@legalwork/ui/react";

import { Page, PageBackground, PageTitlebarRegion } from "@/components/page";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";

/** Tiny progress dots shown above a step's eyebrow — the active step is a
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

/** Wizard footer back button — bottom-left of the left column. */
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

/** Wizard footer skip/continue — bottom-right of the left column. */
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
    return window.localStorage.getItem("legalwork.onboardingDemo") === "1";
  } catch {
    return false;
  }
}

export function OnboardingCover(props: {
  /** Left column content (max-w constrained by the step itself). */
  children: ReactNode;
  /** Content inside the dark panel. */
  panel: ReactNode;
  /** Bottom navigation of the left column: back at the left edge, skip or
   * continue at the right edge. */
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  panelColors?: [string, string, string, string];
  /** Width split; defaults to the provider step's 46/54. */
  leftClassName?: string;
  rightClassName?: string;
}) {
  const colors = props.panelColors ?? ["#0a1633", "#0a67c6", "#0a58c2", "#05080f"];
  const hasFooter = Boolean(props.footerLeft || props.footerRight);
  return (
    <div className="fixed inset-0 z-40 bg-dls-surface">
      <Page className="min-h-screen bg-dls-surface">
        <PageBackground />
        <PageTitlebarRegion />
        <ScrollArea className="relative z-10">
          <ScrollAreaViewport>
            <div className="flex min-h-screen">
              <div
                className={
                  props.leftClassName ?? "flex w-full flex-col px-8 pb-8 pt-16 lg:w-[46%] lg:px-16"
                }
              >
                <div className="flex flex-1 flex-col justify-center py-8">{props.children}</div>
                {hasFooter ? (
                  <div className="flex min-h-9 items-center justify-between gap-4">
                    <div>{props.footerLeft}</div>
                    <div>{props.footerRight}</div>
                  </div>
                ) : null}
              </div>
              <div
                className={
                  props.rightClassName ??
                  "hidden lg:flex lg:w-[54%] lg:items-center lg:justify-center lg:p-6"
                }
              >
                <div className="relative h-full max-h-[780px] w-full overflow-hidden rounded-[28px] bg-[#05080f] shadow-[0_30px_80px_-40px_rgba(5,12,40,0.6)]">
                  <div className="absolute inset-0 z-0">
                    <PaperGrainGradient
                      className="size-full"
                      speed={0}
                      scale={1.1}
                      rotation={0}
                      offsetX={0}
                      offsetY={0}
                      softness={0.75}
                      intensity={0.55}
                      noise={0.16}
                      shape="corners"
                      frame={37706.748}
                      colors={colors}
                      colorBack="#05080f"
                    />
                  </div>
                  <div className="pointer-events-none absolute inset-0 z-10 rounded-[28px] ring-1 ring-inset ring-white/10" />
                  <div className="relative z-20 flex h-full flex-col justify-between gap-10 p-10">
                    {props.panel}
                  </div>
                </div>
              </div>
            </div>
          </ScrollAreaViewport>
        </ScrollArea>
      </Page>
    </div>
  );
}
