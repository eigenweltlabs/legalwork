/** @jsxImportSource react */
import { PaperGrainGradient } from "@legalwork/ui/react";

import { t } from "../../../i18n";
import { Page, PageBackground, PageTitlebarRegion } from "@/components/page";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// The "how" — three plain-English steps.
const steps = [
  {
    n: "01",
    title: "Open a folder of documents",
    desc: "Point LegalWork at any folder on this computer.",
  },
  {
    n: "02",
    title: "Ask in plain English",
    desc: "“Redline this NDA for the buyer.” “Build a review grid across these contracts.”",
  },
  {
    n: "03",
    title: "Review, redline, iterate",
    desc: "Accept tracked changes, refine, and save the result as a reusable workflow.",
  },
];

// The "what" — capabilities, as an editorial ledger (not tiles).
const capabilities = [
  { title: "Review & redline", desc: "Mark up contracts as tracked changes, right in Word." },
  { title: "Tabular review", desc: "Extract terms across many documents into a sourced review grid." },
  { title: "Draft documents", desc: "Briefs, memos, contracts, and engagement letters." },
  { title: "Bring your own model", desc: "Connect AWS Bedrock, Azure OpenAI, or your own provider." },
  { title: "Runs on this machine", desc: "The agent works locally — data is only shared with the model you choose." },
];

type WelcomePageProps = {
  onGetStarted: () => void;
  getStartedLabel?: string;
  busy?: boolean;
  error?: string | null;
  manualFolder?: string;
  onManualFolderChange?: (value: string) => void;
  onUseManualFolder?: () => void;
  showManualFolder?: boolean;
};

export function WelcomePage({
  onGetStarted,
  getStartedLabel,
  busy,
  error,
}: WelcomePageProps) {
  return (
    <Page className="min-h-screen bg-background">
      <PageBackground />
      <PageTitlebarRegion />

      <ScrollArea className="relative z-10">
        <ScrollAreaViewport>
          <div className="flex min-h-screen">
            {/* ---- Left: the entry ---- */}
            <div className="flex w-full flex-col justify-center px-8 py-16 lg:w-[46%] lg:px-16">
              <div className="flex w-full max-w-md flex-col gap-11">
                <div>
                  <span className="lw-section-eyebrow uppercase text-dls-secondary">Local computer-use agent</span>
                  <h1 className="mt-4 text-[40px] font-medium leading-[1.02] tracking-[-0.04em] text-dls-text">
                    {t("welcome.title")}
                  </h1>
                  <p className="mt-4 max-w-sm text-[15px] leading-[1.6] text-dls-secondary">
                    A computer-use agent that runs on this machine. Point it at a folder of documents and it
                    reads, drafts, and redlines them for you — in plain English.
                  </p>
                </div>

                {/* Steps — editorial, hairline-separated, mono numbers */}
                <div className="flex flex-col">
                  {steps.map((step, index) => (
                    <div
                      key={step.n}
                      className={cn("flex items-start gap-4 py-4", index > 0 && "border-t border-dls-border")}
                    >
                      <span className="pt-0.5 font-mono text-[12px] tabular-nums text-dls-secondary/70">
                        {step.n}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[15px] font-medium tracking-[-0.01em] text-dls-text">{step.title}</div>
                        <div className="mt-1 text-[13px] leading-relaxed text-dls-secondary">{step.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-3">
                  <Button size="lg" className="w-full" onClick={onGetStarted} disabled={busy}>
                    {busy ? t("welcome.creating_workspace") : getStartedLabel || t("welcome.get_started")}
                  </Button>
                  {error ? <p className="text-center text-xs text-destructive">{error}</p> : null}
                  <p className="text-center text-[12px] leading-relaxed text-dls-secondary/80">
                    Runs on this machine. Connect AWS, Azure, or your own model — your data is only shared with
                    the model you choose.
                  </p>
                </div>
              </div>
            </div>

            {/* ---- Right: the "lab" showcase — dark panel, Eigenwelt blue grain ---- */}
            <div className="hidden lg:flex lg:w-[54%] lg:items-center lg:justify-center lg:p-6">
              <div className="relative h-full max-h-[780px] w-full overflow-hidden rounded-[28px] bg-[#05080f] shadow-[0_30px_80px_-40px_rgba(5,12,40,0.6)]">
                {/* Eigenwelt paper-grain gradient, deep navy → electric blue */}
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
                {/* subtle inner ring */}
                <div className="pointer-events-none absolute inset-0 z-10 rounded-[28px] ring-1 ring-inset ring-white/10" />

                {/* Content */}
                <div className="relative z-20 flex h-full flex-col justify-between gap-10 p-10">
                  <div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">What it does</span>
                    <h2 className="mt-4 max-w-[16ch] text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-white">
                      Built for your documents.
                    </h2>
                  </div>

                  <div className="divide-y divide-white/10 border-y border-white/10">
                    {capabilities.map((cap) => (
                      <div key={cap.title} className="group flex items-baseline gap-4 py-3.5">
                        <span className="mt-1 size-1.5 shrink-0 translate-y-1.5 rounded-full bg-[#2352DE]" />
                        <div className="min-w-0">
                          <div className="text-[14px] font-medium tracking-[-0.01em] text-white">{cap.title}</div>
                          <div className="mt-0.5 text-[12.5px] leading-snug text-white/55">{cap.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                    Runs locally · Your model · Your data
                  </p>
                </div>
              </div>
            </div>
          </div>
        </ScrollAreaViewport>
      </ScrollArea>
    </Page>
  );
}
