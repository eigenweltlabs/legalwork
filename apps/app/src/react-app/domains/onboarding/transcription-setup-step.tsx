/** @jsxImportSource react */
/**
 * Onboarding: the quick-setup cover — microphone access, Office add-ins
 * (per app, with the real install flow and its analytics), and an on-device
 * transcription model. Everything is skippable and reachable later in
 * Settings; this step exists so the app is genuinely usable the moment
 * onboarding ends.
 */
import { useEffect, useState } from "react";
import { ArrowRight, Check, Download, FileText, Loader2, Mic } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { desktopBridge } from "@/app/lib/desktop";
import type { OfficeAddinAppId } from "@legalwork/types/desktop-ipc";
import { t } from "@/i18n";

import { tierForModelId, tierName } from "../recorder/model-tiers";
import { useRecorderStore } from "../recorder/recorder-store";
import { OnboardingCover } from "./onboarding-cover";

function SetupRow(props: {
  icon: React.ReactNode;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dls-border bg-dls-surface/60 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          {props.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-dls-text">{props.title}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-dls-secondary">{props.body}</p>
        </div>
      </div>
      <div className="mt-4">{props.children}</div>
    </div>
  );
}

function MicrophoneRow() {
  const store = useRecorderStore();
  const [busy, setBusy] = useState(false);
  const state = store.permissions?.microphone ?? "unknown";
  const granted = state === "granted";

  const allow = () => {
    if (state === "not-determined" || state === "unknown") {
      setBusy(true);
      void store
        .requestPermission("microphone")
        .then(() => captureAnalyticsEvent("onboarding_setup_mic_granted"))
        .finally(() => setBusy(false));
    } else {
      void store.openPermissionSettings("microphone");
    }
  };

  return (
    <SetupRow
      icon={<Mic className="size-[18px]" />}
      title={t("onboarding_setup.mic_title")}
      body={t("onboarding_setup.mic_body")}
    >
      {granted ? (
        <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-green-11">
          <Check className="size-4" />
          {t("onboarding_setup.mic_granted")}
        </span>
      ) : (
        <Button variant="outline" onClick={allow} disabled={busy}>
          {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
          {state === "denied" ? t("onboarding_setup.mic_open_settings") : t("onboarding_setup.mic_allow")}
        </Button>
      )}
    </SetupRow>
  );
}

function OfficeRow() {
  const [apps, setApps] = useState<
    { id: OfficeAddinAppId; label: string; enabled: boolean; installed: boolean }[]
  >([]);
  const [supported, setSupported] = useState(true);
  const [busyApp, setBusyApp] = useState<OfficeAddinAppId | null>(null);
  const [installedNow, setInstalledNow] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const install = async (app: { id: OfficeAddinAppId; label: string }) => {
    setBusyApp(app.id);
    setError(null);
    try {
      await desktopBridge.officeAddinInstall(app.id);
      captureAnalyticsEvent("office_addin_installed", { app: app.id, surface: "onboarding" });
      setInstalledNow(true);
      await refresh();
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setBusyApp(null);
    }
  };

  const pending = apps.filter((app) => !app.enabled);
  const allEnabled = apps.length > 0 && pending.length === 0;

  return (
    <SetupRow
      icon={<FileText className="size-[18px]" />}
      title={t("onboarding_setup.office_title")}
      body={t("onboarding_setup.office_body")}
    >
      {!supported ? (
        <p className="text-[12px] text-dls-secondary">{t("onboarding_setup.office_unsupported")}</p>
      ) : apps.length === 0 ? (
        <p className="text-[12px] text-dls-secondary">{t("onboarding_setup.office_none")}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {allEnabled ? (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-green-11">
              <Check className="size-4" />
              {t("onboarding_setup.office_installed")}
            </span>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pending.map((app) => (
                <Button
                  key={app.id}
                  variant="outline"
                  disabled={busyApp !== null}
                  onClick={() => void install(app)}
                >
                  {busyApp === app.id ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : null}
                  {t("onboarding_setup.office_install_one", { app: app.label })}
                </Button>
              ))}
            </div>
          )}
          {/* First install prompts once for the local certificate trust. */}
          {!allEnabled && !installedNow ? (
            <p className="text-[12px] leading-relaxed text-dls-secondary">
              {t("onboarding_setup.office_cert_note")}
            </p>
          ) : null}
          {installedNow ? (
            <p className="text-[12px] leading-relaxed text-dls-secondary">
              {t("onboarding_setup.office_restart_note")}
            </p>
          ) : null}
          {error ? <p className="text-[12px] text-red-11">{error}</p> : null}
        </div>
      )}
    </SetupRow>
  );
}

function ModelRow() {
  const store = useRecorderStore();
  const recommendedId = store.bootstrap?.device?.recommendedModelId ?? "whisper-small";
  const model = store.bootstrap?.models.find((entry) => entry.id === recommendedId);
  const tier = tierForModelId(recommendedId);
  const progress =
    model && model.totalBytes > 0 ? Math.round((model.downloadedBytes / model.totalBytes) * 100) : 0;
  const sizeMb = model && model.totalBytes > 0 ? Math.round(model.totalBytes / 1_000_000) : null;

  const installed = model?.state === "installed";
  const downloading = model?.state === "downloading";

  return (
    <SetupRow
      icon={<Download className="size-[18px]" />}
      title={t("onboarding_setup.model_title")}
      body={t("onboarding_setup.model_body")}
    >
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
        <Button
          variant="outline"
          onClick={() => {
            captureAnalyticsEvent("onboarding_setup_model_download", { model: recommendedId });
            void store.downloadModel(recommendedId);
          }}
          disabled={!model}
        >
          <Download data-icon="inline-start" />
          {t("onboarding_setup.model_download", { tier: tier ? tierName(tier.key) : "" })}
          {sizeMb ? <span className="text-dls-secondary"> · {sizeMb} MB</span> : null}
        </Button>
      )}
    </SetupRow>
  );
}

export function TranscriptionSetupStep(props: { onDone: (skipped: boolean) => void }) {
  const store = useRecorderStore();
  useEffect(() => {
    captureAnalyticsEvent("onboarding_setup_viewed");
    void store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <OnboardingCover
      panelColors={["#0a1633", "#18498B", "#2352DE", "#05080f"]}
      leftClassName="flex w-full flex-col px-8 pt-16 pb-10 lg:w-[52%] lg:px-16"
      rightClassName="hidden lg:flex lg:w-[48%] lg:items-center lg:justify-center lg:p-6"
      panel={
        <>
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
        </>
      }
    >
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
            <MicrophoneRow />
            <OfficeRow />
            <ModelRow />
          </div>
        </div>
      </div>

      <div className="flex w-full max-w-lg items-center justify-between">
        <button
          type="button"
          className="text-[13px] text-dls-secondary transition-colors hover:text-dls-text"
          onClick={() => props.onDone(true)}
        >
          {t("onboarding_setup.skip")}
        </button>
        <Button onClick={() => props.onDone(false)}>
          {t("onboarding_setup.continue")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </OnboardingCover>
  );
}
