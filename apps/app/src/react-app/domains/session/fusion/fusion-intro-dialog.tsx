/** @jsxImportSource react */
import { Bot, GitMerge, MessagesSquare, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

const FUSION_INTRO_STORAGE_KEY = "legalwork.fusionIntroSeen";

const entries = [
  {
    icon: Workflow,
    titleKey: "fusion.intro_main_title",
    bodyKey: "fusion.intro_main_body",
  },
  {
    icon: Bot,
    titleKey: "fusion.intro_subagents_title",
    bodyKey: "fusion.intro_subagents_body",
  },
  {
    icon: MessagesSquare,
    titleKey: "fusion.intro_followups_title",
    bodyKey: "fusion.intro_followups_body",
  },
];

export function shouldShowFusionIntro(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FUSION_INTRO_STORAGE_KEY) !== "1";
  } catch {
    return false;
  }
}

export function markFusionIntroSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FUSION_INTRO_STORAGE_KEY, "1");
  } catch {
    // Storage unavailable: keep the toggle behavior unchanged.
  }
}

export function FusionIntroDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
        <div className="relative overflow-hidden bg-[linear-gradient(135deg,#e24b52_0%,#e49b42_23%,#3ea85d_48%,#2597c9_72%,#6d4fd8_100%)] px-7 pb-8 pt-7 text-white">
          <div
            aria-hidden
            className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(0,0,0,0.2))]"
          />
          <div className="relative">
            <span className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white/80">
              <GitMerge size={13} />
              {t("fusion.intro_eyebrow")}
            </span>
            <DialogTitle className="mt-3 text-[26px] font-medium leading-[1.08] tracking-[-0.03em] text-white drop-shadow-sm">
              {t("fusion.intro_headline")}
            </DialogTitle>
            <p className="mt-2.5 max-w-sm text-[13px] leading-[1.6] text-white/85">
              {t("fusion.intro_body")}
            </p>
          </div>
        </div>

        <div className="flex flex-col px-7 py-2">
          {entries.map((entry, index) => {
            const Icon = entry.icon;
            return (
              <div
                key={entry.titleKey}
                className={`flex items-start gap-4 py-4 ${index > 0 ? "border-t border-dls-border" : ""}`}
              >
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-dls-border bg-gray-2 text-gray-11 shadow-sm">
                  <Icon size={15} />
                </span>
                <div className="min-w-0">
                  <div className="text-[14px] font-medium tracking-[-0.01em] text-dls-text">
                    {t(entry.titleKey)}
                  </div>
                  <div className="mt-1 text-[13px] leading-relaxed text-dls-secondary">{t(entry.bodyKey)}</div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-7 pb-6 pt-1">
          <Button
            size="lg"
            className="w-full text-white"
            onClick={() => props.onOpenChange(false)}
          >
            {t("fusion.intro_cta")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
