/** @jsxImportSource react */
import { PaperGrainGradient } from "@legalwork/ui/react";
import { ArrowRightIcon, FlaskConicalIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";

import { Page, PageBackground, PageTitlebarRegion } from "@/components/page";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { ProviderIcon } from "../../design-system/provider-icon";

type ProviderSelectionStepProps = {
  // Pre-selects `providerId` and opens the real connect flow in the session.
  onConnect: (providerId: string, method?: "oauth" | "api") => void;
  onSkip: () => void;
};

// What the dark panel reads (positioning, mirrors the intro page). Only
// Eigenwelt is named; everything else is described generically.
const panelProviders = [
  { title: "Eigenwelt Model API", desc: "Eigenwelt's own deployments — org credits, zero prompt retention." },
  { title: "Your own cloud", desc: "Run frontier models inside the cloud account you already operate." },
  { title: "Any OpenAI-compatible endpoint", desc: "Self-hosted or private — point LegalWork at any URL." },
  { title: "Your own API keys", desc: "Bring a key from any supported provider. Nothing routes through us." },
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
                      LegalWork runs on this machine. Your documents are only ever shared with the model you
                      connect, and nothing else.
                    </p>
                  </div>

                  {/* Eigenwelt — sign in / up, then included free models */}
                  <div className="space-y-2.5">
                    <span className="lw-section-eyebrow uppercase text-dls-secondary/80">Recommended</span>

                    {/* Sign in / create an Eigenwelt account (server-owned OAuth) */}
                    <button
                      type="button"
                      className={`${quickButtonClass} border-[rgba(var(--dls-accent-rgb),0.45)]`}
                      onClick={() => onConnect("eigenwelt", "oauth")}
                    >
                      <ProviderIcon providerId="eigenwelt" size={16} className="shrink-0 text-dls-text" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-dls-text">Sign in with Eigenwelt</div>
                        <div className="text-[12px] text-dls-secondary">
                          Create or connect your firm account — org credits, premium models, zero prompt retention.
                        </div>
                      </div>
                      <ArrowRightIcon className="size-4 shrink-0 text-dls-secondary/60 transition-transform group-hover:translate-x-0.5" />
                    </button>

                    {/* Included free models (same path as skipping) */}
                    <button type="button" className={quickButtonClass} onClick={onSkip}>
                      <FlaskConicalIcon className="size-4 shrink-0 text-dls-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-dls-text">Use Eigenwelt free models</div>
                        <div className="text-[12px] text-dls-secondary">Try LegalWork right away. No account, no key.</div>
                      </div>
                      <ArrowRightIcon className="size-4 shrink-0 text-dls-secondary/60 transition-transform group-hover:translate-x-0.5" />
                    </button>
                  </div>

                  <div className="-mt-4 flex max-w-sm items-start gap-2.5">
                    <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-11" />
                    <p className="text-[12px] leading-relaxed text-amber-11">
                      Free models are included to try LegalWork. Usage data is
                      logged, so please keep privileged, client, and matter data out. For real
                      work, sign in or connect your own model.
                    </p>
                  </div>

                  {/* Divider — us above, everything else below */}
                  <div className="h-px w-full bg-dls-border" />

                  {/* Any other provider — searchable list of every supported provider */}
                  <div className="space-y-2.5">
                    <button type="button" className={quickButtonClass} onClick={() => onConnect("")}>
                      <SearchIcon className="size-4 shrink-0 text-dls-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-dls-text">Use any other provider</div>
                        <div className="text-[12px] text-dls-secondary">
                          Bring your own key or endpoint — every supported provider, connected directly.
                        </div>
                      </div>
                      <ArrowRightIcon className="size-4 shrink-0 text-dls-secondary/60 transition-transform group-hover:translate-x-0.5" />
                    </button>
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
                      colors={["#0a1633", "#0a67c6", "#0a58c2", "#05080f"]}
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
                          <span className="mt-1 size-1.5 shrink-0 translate-y-1.5 rounded-full bg-[#0a58c2]" />
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
