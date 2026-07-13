/** @jsxImportSource react */
/**
 * Final onboarding cover: two optional one-tap installs — add the Office
 * add-ins (Word / Outlook) and download an on-device transcription model.
 * Both are skippable; everything here is also reachable later in Settings.
 */
import { useEffect, useState } from "react";
import { PaperGrainGradient } from "@legalwork/ui/react";
import { ArrowRight, Check, Download, FileText, Loader2, Mic } from "lucide-react";

import { Page, PageBackground, PageTitlebarRegion } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { desktopBridge } from "@/app/lib/desktop";
import type { OfficeAddinAppId } from "@legalwork/types/desktop-ipc";
import { t } from "@/i18n";

import { tierForModelId, tierName } from "../recorder/model-tiers";
import { useRecorderStore } from "../recorder/recorder-store";

function OfficeHalf() {
  const [apps, setApps] = useState<{ id: OfficeAddinAppId; label: string; enabled: boolean; installed: boolean }[]>([]);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const refresh = async () => {
    try {
      const status = await desktopBridge.officeAddinStatus();
      setSupported(status.supported);
      setApps(status.apps.filter((app) => app.installed));
    } catch {
      setSupported(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const detected = apps.filter((app) => !app.enabled);
  const allEnabled = apps.length > 0 && detected.length === 0;

  const install = async () => {
    setBusy(true);
    try {
      for (const app of detected) {
        await desktopBridge.officeAddinInstall(app.id).catch(() => undefined);
      }
      await refresh();
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-dls-border bg-dls-surface/60 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <FileText className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-dls-text">{t("onboarding_setup.office_title")}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-dls-secondary">
            {t("onboarding_setup.office_body")}
          </p>
        </div>
      </div>
      <div className="mt-4">
        {!supported ? (
          <p className="text-[12px] text-dls-secondary">{t("onboarding_setup.office_unsupported")}</p>
        ) : apps.length === 0 ? (
          <p className="text-[12px] text-dls-secondary">{t("onboarding_setup.office_none")}</p>
        ) : allEnabled || done ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-green-11">
            <Check className="size-4" />
            {t("onboarding_setup.office_installed")}
          </span>
        ) : (
          <Button onClick={() => void install()} disabled={busy}>
            {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
            {t("onboarding_setup.office_install", {
              apps: detected.map((app) => app.label).join(" & "),
            })}
          </Button>
        )}
      </div>
    </div>
  );
}

function ModelHalf() {
  const store = useRecorderStore();
  const recommendedId = store.bootstrap?.device?.recommendedModelId ?? "whisper-small";
  const model = store.bootstrap?.models.find((entry) => entry.id === recommendedId);
  const tier = tierForModelId(recommendedId);
  const progress =
    model && model.totalBytes > 0 ? Math.round((model.downloadedBytes / model.totalBytes) * 100) : 0;

  useEffect(() => {
    void store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installed = model?.state === "installed";
  const downloading = model?.state === "downloading";

  return (
    <div className="rounded-2xl border border-dls-border bg-dls-surface/60 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Mic className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-dls-text">{t("onboarding_setup.model_title")}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-dls-secondary">
            {t("onboarding_setup.model_body")}
          </p>
        </div>
      </div>
      <div className="mt-4">
        {installed ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-green-11">
            <Check className="size-4" />
            {t("onboarding_setup.model_installed", { tier: tier ? tierName(tier.key) : "" })}
          </span>
        ) : downloading ? (
          <div className="flex items-center gap-3">
            <Progress value={progress} className="h-1.5 w-40" />
            <span className="text-[12px] tabular-nums text-dls-secondary">{progress}%</span>
          </div>
        ) : (
          <Button onClick={() => void store.downloadModel(recommendedId)} disabled={!model}>
            <Download data-icon="inline-start" />
            {t("onboarding_setup.model_download", { tier: tier ? tierName(tier.key) : "" })}
          </Button>
        )}
      </div>
    </div>
  );
}

export function TranscriptionSetupStep(props: { onDone: () => void }) {
  return (
    <div className="fixed inset-0 z-40 bg-dls-surface">
      <Page className="min-h-screen bg-dls-surface">
        <PageBackground />
        <PageTitlebarRegion />
        <ScrollArea className="relative z-10">
          <ScrollAreaViewport>
            <div className="flex min-h-screen">
              <div className="flex w-full flex-col px-8 pt-16 pb-10 lg:w-[52%] lg:px-16">
                <div className="flex w-full flex-1 items-center">
                  <div className="flex w-full max-w-lg flex-col gap-8">
                    <div>
                      <span className="lw-section-eyebrow uppercase text-dls-secondary">
                        {t("onboarding_setup.eyebrow")}
                      </span>
                      <h1 className="mt-3 text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
                        {t("onboarding_setup.title")}
                      </h1>
                      <p className="mt-3 max-w-md text-[14px] leading-[1.6] text-dls-secondary">
                        {t("onboarding_setup.subtitle")}
                      </p>
                    </div>

                    <div className="flex flex-col gap-3">
                      <OfficeHalf />
                      <ModelHalf />
                    </div>
                  </div>
                </div>

                <div className="flex w-full max-w-lg items-center justify-between">
                  <button
                    type="button"
                    className="text-[13px] text-dls-secondary transition-colors hover:text-dls-text"
                    onClick={props.onDone}
                  >
                    {t("onboarding_setup.skip")}
                  </button>
                  <Button onClick={props.onDone}>
                    {t("onboarding_setup.continue")}
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                </div>
              </div>

              <div className="hidden lg:flex lg:w-[48%] lg:items-center lg:justify-center lg:p-6">
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
                        {t("onboarding_setup.panel_eyebrow")}
                      </span>
                      <h2 className="mt-4 max-w-[16ch] text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-white">
                        {t("onboarding_setup.panel_title")}
                      </h2>
                    </div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                      {t("onboarding_setup.panel_footer")}
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
