/** @jsxImportSource react */
import { useState } from "react";
import { PaperGrainGradient } from "@legalwork/ui/react";
import { ArrowRightIcon, FolderOpenIcon, Loader2 } from "lucide-react";

import { Page, PageBackground, PageTitlebarRegion } from "@/components/page";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";

type TemplateWorkflowsStepProps = {
  // Opens the folder picker and starts the local generation run. Resolves true
  // when a run started (advance), false when the user cancelled the picker or
  // the start failed (stay on the step; error surfaced via the return message).
  onStart: () => Promise<{ started: boolean; message?: string }>;
  onSkip: () => void;
};

// What the dark panel reads (positioning, mirrors the provider step's panel).
// Benefit-led for lawyers, not mechanics.
const panelPoints = [
  {
    title: "Set up automatically",
    desc: "One workflow per template, created for you. No configuration, nothing to write.",
  },
  {
    title: "Agents draft from your templates",
    desc: "Every new document starts from your precedent, not a generic form.",
  },
  {
    title: "Your standards, every time",
    desc: "Intake questions, clauses, and house style come straight from your own documents.",
  },
  {
    title: "Safe to run again",
    desc: "Templates you have covered are skipped. Rerun it whenever your precedent changes.",
  },
];

const quickButtonClass =
  "group flex w-full items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-left transition-colors hover:border-[rgba(var(--dls-accent-rgb),0.45)] hover:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Optional onboarding step between model selection and analytics: point a local
 * agent at a folder of the firm's templates and it drafts one reusable workflow
 * per template while onboarding continues.
 */
export function TemplateWorkflowsStep({ onStart, onSkip }: TemplateWorkflowsStepProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const result = await onStart();
      if (!result.started && result.message) setError(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start workflow generation.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-dls-surface">
      <Page className="min-h-screen bg-dls-surface">
        <PageBackground />
        <PageTitlebarRegion />

        <ScrollArea className="relative z-10">
          <ScrollAreaViewport>
            <div className="flex min-h-screen">
              {/* ---- Left: choose the templates folder ---- */}
              <div className="flex w-full flex-col px-8 pt-16 pb-10 lg:w-[46%] lg:px-16">
                <div className="flex w-full flex-1 items-center">
                  <div className="flex w-full max-w-md flex-col gap-8">
                    <div>
                      <span className="lw-section-eyebrow uppercase text-dls-secondary">Step three · Your templates</span>
                      <h1 className="mt-3 text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
                        Turn your templates into workflows.
                      </h1>
                      <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">
                        Choose a folder with your firm&apos;s templates: engagement letters, contracts, memos.
                        Tasks an agent to read each one and draft a reusable workflow for it while you finish
                        setting up.
                      </p>
                    </div>

                    <div className="space-y-2.5">
                      <span className="lw-section-eyebrow uppercase text-dls-secondary/80">Start in the background</span>
                      <button type="button" className={quickButtonClass} onClick={() => void handleStart()} disabled={starting}>
                        {starting ? (
                          <Loader2 className="size-4 shrink-0 animate-spin text-dls-secondary" />
                        ) : (
                          <FolderOpenIcon className="size-4 shrink-0 text-dls-secondary" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-[14px] font-medium text-dls-text">
                            {starting ? "Starting…" : "Choose your templates folder"}
                          </div>
                          <div className="text-[12px] text-dls-secondary">
                            One reusable workflow per template, with the original attached.
                          </div>
                        </div>
                        <ArrowRightIcon className="size-4 shrink-0 text-dls-secondary/60 transition-transform group-hover:translate-x-0.5" />
                      </button>
                      <p className="text-[12px] leading-relaxed text-dls-secondary">
                        Runs on this computer with your selected model. The results land in your firm&apos;s
                        library under Workflows.
                      </p>
                      {error ? <p className="text-[12px] leading-relaxed text-red-500">{error}</p> : null}
                    </div>
                  </div>
                </div>

                <div className="flex w-full max-w-md justify-end">
                  <Button variant="outline" onClick={onSkip} disabled={starting}>
                    Skip for now
                    <ArrowRightIcon data-icon="inline-end" />
                  </Button>
                </div>
              </div>

              {/* ---- Right: what it builds ---- */}
              <div className="hidden lg:flex lg:w-[54%] lg:items-center lg:justify-center lg:p-6">
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
                      colors={["#0a1633", "#18498B", "#2352DE", "#05080f"]}
                      colorBack="#05080f"
                    />
                  </div>
                  <div className="pointer-events-none absolute inset-0 z-10 rounded-[28px] ring-1 ring-inset ring-white/10" />

                  <div className="relative z-20 flex h-full flex-col justify-between gap-10 p-10">
                    <div>
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
                        What your firm gets
                      </span>
                      <h2 className="mt-4 max-w-[16ch] text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-white">
                        Your templates become how your firm drafts.
                      </h2>
                    </div>

                    <div className="divide-y divide-white/10 border-y border-white/10">
                      {panelPoints.map((point) => (
                        <div key={point.title} className="flex items-baseline gap-4 py-3.5">
                          <span className="mt-1 size-1.5 shrink-0 translate-y-1.5 rounded-full bg-[#2352DE]" />
                          <div className="min-w-0">
                            <div className="text-[14px] font-medium tracking-[-0.01em] text-white">{point.title}</div>
                            <div className="mt-0.5 text-[12.5px] leading-snug text-white/55">{point.desc}</div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
                        Yours to refine
                      </span>
                      <p className="mt-2 text-[13px] leading-snug text-white/70">
                        Partners and associates run the same workflows. Correct one draft and the whole firm
                        drafts better from then on.
                      </p>
                    </div>

                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                      Runs locally · Your templates · Your library
                    </p>
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
