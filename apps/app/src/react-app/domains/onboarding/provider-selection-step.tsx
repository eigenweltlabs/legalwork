/** @jsxImportSource react */
import { PaperGrainGradient } from "@legalwork/ui/react";
import { ArrowRightIcon, GithubIcon, SearchIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";

import { Page, PageBackground, PageTitlebarRegion } from "@/components/page";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";

type ProviderSelectionStepProps = {
  // Pre-selects `providerId` and opens the real connect flow in the session.
  onConnect: (providerId: string, method?: "oauth" | "api") => void;
  onSkip: () => void;
};

// What the dark panel reads (positioning, mirrors the intro page).
const panelProviders = [
  { title: "AWS Bedrock", desc: "Claude, Llama, and more — inside your own AWS account." },
  { title: "Azure OpenAI", desc: "GPT models on your Azure tenant." },
  { title: "Mistral", desc: "Open-weight models, EU-hosted or your own." },
  { title: "Your own endpoint", desc: "Any OpenAI-compatible URL — self-hosted or private." },
];

const quickButtonClass =
  "group flex w-full items-center gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-left transition-colors hover:border-[rgba(var(--dls-accent-rgb),0.45)] hover:bg-dls-hover";

export function ProviderSelectionStep({ onConnect, onSkip }: ProviderSelectionStepProps) {
  return (
    <div className="fixed inset-0 z-40 bg-dls-surface">
      <Page className="min-h-screen bg-dls-surface">
        <PageBackground />
        <PageTitlebarRegion />

        <ScrollArea className="relative z-10">
          <ScrollAreaViewport>
            <div className="flex min-h-screen">
              {/* ---- Left: connect ---- */}
              <div className="flex w-full flex-col justify-center px-8 py-16 lg:w-[46%] lg:px-16">
                <div className="flex w-full max-w-md flex-col gap-8">
                  <div>
                    <span className="lw-section-eyebrow uppercase text-dls-secondary">Step two · Your model</span>
                    <h1 className="mt-3 text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
                      Connect a model.
                    </h1>
                    <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">
                      LegalWork runs on this machine — your documents are only ever shared with the model you
                      connect, and nothing else.
                    </p>
                  </div>

                  {/* Quick connect — subscriptions, for testing */}
                  <div className="space-y-2.5">
                    <span className="lw-section-eyebrow uppercase text-dls-secondary/80">Quick connect · for testing</span>
                    <button type="button" className={quickButtonClass} onClick={() => onConnect("openai", "oauth")}>
                      <SparklesIcon className="size-4 shrink-0 text-dls-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-dls-text">Sign in with OpenAI</div>
                        <div className="text-[12px] text-dls-secondary">Use your ChatGPT subscription — no API key.</div>
                      </div>
                      <ArrowRightIcon className="size-4 shrink-0 text-dls-secondary/60 transition-transform group-hover:translate-x-0.5" />
                    </button>
                    <button type="button" className={quickButtonClass} onClick={() => onConnect("github-copilot", "oauth")}>
                      <GithubIcon className="size-4 shrink-0 text-dls-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-dls-text">Sign in with GitHub Copilot</div>
                        <div className="text-[12px] text-dls-secondary">Use your Copilot subscription.</div>
                      </div>
                      <ArrowRightIcon className="size-4 shrink-0 text-dls-secondary/60 transition-transform group-hover:translate-x-0.5" />
                    </button>
                  </div>

                  {/* Enterprise / private — searchable list of every provider */}
                  <div className="space-y-2.5">
                    <span className="lw-section-eyebrow uppercase text-dls-secondary/80">Enterprise &amp; private</span>
                    <button type="button" className={quickButtonClass} onClick={() => onConnect("")}>
                      <SearchIcon className="size-4 shrink-0 text-dls-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-dls-text">Browse all providers</div>
                        <div className="text-[12px] text-dls-secondary">
                          Search AWS Bedrock, Azure, Mistral — every supported provider.
                        </div>
                      </div>
                      <ArrowRightIcon className="size-4 shrink-0 text-dls-secondary/60 transition-transform group-hover:translate-x-0.5" />
                    </button>
                    <p className="text-[12px] leading-relaxed text-dls-secondary">
                      Run on your own cloud — connect with your own keys, any OpenAI-compatible endpoint.
                    </p>
                  </div>

                  <div className="flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={onSkip}
                      className="self-start text-[13px] text-dls-secondary transition-colors hover:text-dls-text"
                    >
                      Skip for now, use free models
                    </button>
                    <div className="flex max-w-sm items-start gap-2.5 rounded-xl border border-amber-6/40 bg-amber-2/30 px-3.5 py-3">
                      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-11" />
                      <p className="text-[12px] leading-relaxed text-amber-11">
                        Free models are slower, lower-quality test models, and these providers may
                        train on what you send them. Don&apos;t use them with client or matter data;
                        use them only to try LegalWork. Connect your own model above for real work.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* ---- Right: where it can run ---- */}
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
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">Connect anywhere</span>
                      <h2 className="mt-4 max-w-[16ch] text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-white">
                        Your model. Your cloud. Your keys.
                      </h2>
                    </div>

                    <div className="divide-y divide-white/10 border-y border-white/10">
                      {panelProviders.map((provider) => (
                        <div key={provider.title} className="flex items-baseline gap-4 py-3.5">
                          <span className="mt-1 size-1.5 shrink-0 translate-y-1.5 rounded-full bg-[#2352DE]" />
                          <div className="min-w-0">
                            <div className="text-[14px] font-medium tracking-[-0.01em] text-white">{provider.title}</div>
                            <div className="mt-0.5 text-[12.5px] leading-snug text-white/55">{provider.desc}</div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
                        Need your own model?
                      </span>
                      <p className="mt-2 text-[13px] leading-snug text-white/70">
                        Eigenwelt Labs trains and hosts custom models for your firm — fine-tuned on your
                        documents and run on infrastructure you control.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                        <a
                          href="https://eigenweltlabs.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[13px] font-medium text-white transition-colors hover:text-white/80"
                        >
                          eigenweltlabs.com
                          <ArrowRightIcon className="size-3.5" />
                        </a>
                        <a
                          href="https://eigenweltlabs.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[13px] font-medium text-[#5b8bff] transition-colors hover:text-[#7da4ff]"
                        >
                          Talk to the team
                          <ArrowRightIcon className="size-3.5" />
                        </a>
                      </div>
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
    </div>
  );
}
