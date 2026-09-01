/** @jsxImportSource react */
/**
 * Onboarding step 1: welcome + pick a workspace folder. Renders on the same
 * OnboardingCover shell as the other steps — dots, centered left column, one
 * action, footer on the panel's bottom line. The panel SHOWS the product:
 * a mini app window running a redline task, plus a capability grid.
 */
import { Check, Loader2 } from "lucide-react";

import { t } from "../../../i18n";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import { OnboardingCover, StepDots } from "./onboarding-cover";

export type WorkspaceCreatePhase = "workspace" | "engine" | "session";

const CREATE_STEPS: Array<{ id: WorkspaceCreatePhase; label: string }> = [
  { id: "workspace", label: "Creating the workspace" },
  { id: "engine", label: "Starting the local engine" },
  { id: "session", label: "Preparing your first session" },
];

/** Modal overlay shown while the workspace is being created — the phases
 * tick off as the route reports progress. Not dismissable: it ends by
 * navigating into the app (or closing on error). */
function WorkspaceCreationOverlay(props: { phase: WorkspaceCreatePhase }) {
  const activeIndex = CREATE_STEPS.findIndex((step) => step.id === props.phase);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-busy="true"
      aria-label="Setting up your workspace"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px] duration-200 animate-in fade-in-0"
    >
      <div className="w-full max-w-[400px] rounded-2xl border border-dls-border bg-dls-surface p-6 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.45)] duration-200 animate-in fade-in-0 zoom-in-95">
        <h2 className="text-[16px] font-medium tracking-[-0.01em] text-dls-text">
          Setting up your workspace
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-dls-secondary">
          This can take a moment on first launch.
        </p>
        <div className="mt-6 flex flex-col gap-3.5">
          {CREATE_STEPS.map((step, index) => {
            const done = index < activeIndex;
            const active = index === activeIndex;
            return (
              <div key={step.id} className="flex items-center gap-3 transition-colors duration-200">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {done ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-green-9 text-white">
                      <Check className="size-3" />
                    </span>
                  ) : active ? (
                    <Loader2 className="size-4 animate-spin text-dls-text" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-dls-border" />
                  )}
                </span>
                <span
                  className={
                    done
                      ? "text-[13.5px] text-dls-text"
                      : active
                        ? "text-[13.5px] font-medium text-dls-text"
                        : "text-[13.5px] text-dls-secondary/60"
                  }
                >
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const capabilities = [
  { title: "Review & redline", desc: "Mark up contracts as tracked changes, right in Word." },
  { title: "Tabular review", desc: "Extract terms across many documents into a review grid." },
  { title: "Draft documents", desc: "Briefs, memos, contracts, and engagement letters." },
  { title: "Meetings & dictation", desc: "Record, transcribe and dictate on this device." },
];

/** A mini LegalWork window — sidebar, a plain-English ask, a redline result. */
function AppWindowMock() {
  return (
    <div className="mx-auto w-full max-w-[400px] overflow-hidden rounded-xl border border-white/10 bg-[#0b1322]/90 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.8)] backdrop-blur">
      {/* window chrome */}
      <div className="flex items-center gap-1.5 border-b border-white/[0.08] px-3.5 py-2.5">
        <span className="size-2 rounded-full bg-white/15" />
        <span className="size-2 rounded-full bg-white/15" />
        <span className="size-2 rounded-full bg-white/15" />
        <span className="ml-2 h-1.5 w-24 rounded bg-white/15" />
      </div>
      <div className="flex">
        {/* sidebar: folders */}
        <div className="w-[108px] shrink-0 space-y-1.5 border-r border-white/[0.08] p-3">
          <div className="mb-2 h-1.5 w-12 rounded bg-white/20" />
          <div className="rounded bg-white/10 px-1.5 py-1.5">
            <div className="h-1.5 w-14 rounded bg-white/55" />
          </div>
          <div className="px-1.5 py-1.5">
            <div className="h-1.5 w-12 rounded bg-white/25" />
          </div>
          <div className="px-1.5 py-1.5">
            <div className="h-1.5 w-16 rounded bg-white/25" />
          </div>
        </div>
        {/* main: the task */}
        <div className="flex-1 p-3.5">
          <div className="ml-auto w-fit max-w-[90%] rounded-lg rounded-tr-sm bg-white/10 px-2.5 py-1.5 text-[11.5px] leading-snug text-white/85">
            Redline this NDA for the buyer.
          </div>
          <div className="mt-2.5 max-w-[92%] rounded-lg rounded-tl-sm bg-[#0a58c2]/25 px-2.5 py-2">
            <div className="h-1.5 w-full rounded bg-white/55" />
            <div className="mt-1 h-1.5 w-[78%] rounded bg-white/55" />
            {/* the redline: deletion + insertion */}
            <div className="mt-2.5 flex items-center gap-1.5 rounded-md bg-white/[0.08] px-2 py-1.5">
              <div className="relative h-1.5 w-[26%] rounded-sm bg-[#f3b4b4]/70">
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[#e26d6d]" />
              </div>
              <div className="h-1.5 w-[38%] rounded-sm bg-[#8fd8a8]/80" />
              <div className="h-1.5 w-[16%] rounded-sm bg-white/25" />
            </div>
          </div>
          <div className="mt-2.5 flex items-center gap-1.5">
            <span className="size-1 rounded-full bg-[#4ade80]" />
            <span className="text-[10px] text-white/50">Tracked changes ready in Word</span>
          </div>
        </div>
      </div>
    </div>
  );
}

type WelcomePageProps = {
  onGetStarted: () => void;
  getStartedLabel?: string;
  busy?: boolean;
  error?: string | null;
  manualFolder?: string;
  onManualFolderChange?: (value: string) => void;
  onUseManualFolder?: () => void;
  showManualFolder?: boolean;
  // Anonymous usage analytics consent (opt-out: on by default).
  analyticsEnabled: boolean;
  onAnalyticsChange: (enabled: boolean) => void;
  /** Creation progress; non-null shows the loading overlay. */
  busyPhase?: WorkspaceCreatePhase | null;
};

export function WelcomePage({
  onGetStarted,
  getStartedLabel,
  busy,
  error,
  analyticsEnabled,
  onAnalyticsChange,
  busyPhase,
}: WelcomePageProps) {
  // Dev/design affordance (like legalwork.onboardingDemo): preview the
  // creation overlay without creating a workspace.
  let overlayPhase = busyPhase ?? null;
  if (import.meta.env.DEV && !overlayPhase) {
    try {
      const demo = window.localStorage.getItem("legalwork.createOverlayDemo");
      if (demo === "workspace" || demo === "engine" || demo === "session") overlayPhase = demo;
    } catch {
      // storage unavailable
    }
  }
  return (
    <OnboardingCover
      panel={
        <>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              What it does
            </span>
            <h2 className="mt-4 max-w-[16ch] text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-white">
              Built for your documents.
            </h2>
          </div>
          <AppWindowMock />
          <div className="grid grid-cols-2 gap-2.5">
            {capabilities.map((cap) => (
              <div key={cap.title} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                <div className="text-[12.5px] font-medium tracking-[-0.01em] text-white">
                  {cap.title}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-white/50">{cap.desc}</div>
              </div>
            ))}
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            Runs on this machine · Your data stays yours
          </p>
        </>
      }
      footerLeft={
        <label className="flex cursor-pointer items-center gap-2.5">
          <Switch
            aria-label="Share anonymous usage analytics"
            checked={analyticsEnabled}
            onCheckedChange={onAnalyticsChange}
            className="data-checked:bg-foreground data-checked:border-transparent"
          />
          <span className="text-[12px] leading-snug text-dls-secondary">
            Share anonymous usage data. Never your documents or prompts. Change anytime in
            Settings.
          </span>
        </label>
      }
    >
      <div className="flex w-full max-w-md flex-col gap-8">
        <div>
          <StepDots step={1} total={4} />
          <h1 className="text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
            {t("welcome.title")}
          </h1>
          <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">
            A computer-use agent that runs on this machine.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Button size="lg" className="w-full justify-center" onClick={onGetStarted} disabled={busy}>
            {busy ? t("welcome.creating_workspace") : getStartedLabel || t("welcome.get_started")}
          </Button>
          {error ? <p className="text-center text-xs text-destructive">{error}</p> : null}
          <p className="text-center text-[12px] leading-5 text-dls-secondary">
            Your documents stay on this computer.
          </p>
        </div>
      </div>
      {overlayPhase ? <WorkspaceCreationOverlay phase={overlayPhase} /> : null}
    </OnboardingCover>
  );
}
