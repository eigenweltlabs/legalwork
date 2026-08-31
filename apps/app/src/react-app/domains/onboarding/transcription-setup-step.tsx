/** @jsxImportSource react */
/**
 * Onboarding: the setup cover, framed from the USER's side — three features
 * to turn on (Office plugins, dictation, meeting recording), never a list of
 * permissions or downloads. Clicking a feature triggers whatever that feature
 * needs (cert trust, microphone prompt, model download) as a consequence of
 * the user's choice. Dictation and meeting recording share one substrate
 * (mic + on-device model): whichever is turned on first does the heavy
 * lifting, the other becomes ready instantly. Everything is skippable and
 * reachable later in Settings.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, FileText, Loader2, Mic, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { desktopBridge } from "@/app/lib/desktop";
import type { OfficeAddinAppId } from "@legalwork/types/desktop-ipc";
import { t } from "@/i18n";

import { formatDictationShortcut } from "../recorder/dictation-shortcut";
import { tierForModelId, tierName } from "../recorder/model-tiers";
import { useRecorderStore } from "../recorder/recorder-store";
import { OnboardingCover } from "./onboarding-cover";

function FeatureCard(props: {
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

function ReadyLine(props: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-green-11">
      <Check className="size-4" />
      {props.text}
    </span>
  );
}

/** Office plugins: per-app one-click installs (the cert trust prompt and the
 * restart note follow the click — real install flow, real analytics). */
function OfficeCard() {
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
    <FeatureCard
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
            <ReadyLine text={t("onboarding_setup.office_installed")} />
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
          {installedNow ? (
            <p className="text-[12px] leading-relaxed text-dls-secondary">
              {t("onboarding_setup.office_restart_note")}
            </p>
          ) : null}
          {error ? <p className="text-[12px] text-red-11">{error}</p> : null}
        </div>
      )}
    </FeatureCard>
  );
}

export function TranscriptionSetupStep(props: { onDone: (skipped: boolean) => void }) {
  const store = useRecorderStore();
  const [wanted, setWanted] = useState<{ dictation: boolean; recording: boolean }>({
    dictation: false,
    recording: false,
  });
  const dictationEnableAttempted = useRef(false);

  useEffect(() => {
    captureAnalyticsEvent("onboarding_setup_viewed");
    void store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared substrate for dictation + meeting recording: mic + local model.
  const micState = store.permissions?.microphone ?? "unknown";
  const micGranted = micState === "granted";
  const recommendedId = store.bootstrap?.device?.recommendedModelId ?? "whisper-small";
  const model = store.bootstrap?.models.find((entry) => entry.id === recommendedId);
  const tier = tierForModelId(recommendedId);
  const modelInstalled = model?.state === "installed";
  const modelDownloading = model?.state === "downloading";
  const progress =
    model && model.totalBytes > 0 ? Math.round((model.downloadedBytes / model.totalBytes) * 100) : 0;
  const sizeMb = model && model.totalBytes > 0 ? Math.round(model.totalBytes / 1_000_000) : null;
  const substrateReady = micGranted && Boolean(modelInstalled);

  const activate = (feature: "dictation" | "recording") => {
    setWanted((current) => ({ ...current, [feature]: true }));
    captureAnalyticsEvent("onboarding_setup_feature", { feature });
    // The user chose the feature — NOW ask for what it needs.
    if (!micGranted) {
      if (micState === "not-determined" || micState === "unknown") {
        void store.requestPermission("microphone");
      } else {
        void store.openPermissionSettings("microphone");
      }
    }
    if (!modelInstalled && !modelDownloading && model) {
      void store.downloadModel(recommendedId);
    }
  };

  // Dictation was chosen and the substrate is ready: turn it on for real
  // (spawns the key monitor; any follow-up OS prompt appears in context).
  useEffect(() => {
    if (!wanted.dictation || !substrateReady || dictationEnableAttempted.current) return;
    dictationEnableAttempted.current = true;
    void store.setSystemDictationEnabled(true).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted.dictation, substrateReady]);

  const dictationShortcut = store.systemDictation
    ? formatDictationShortcut(store.systemDictation.accelerator, store.systemDictation.platform)
    : null;

  const substrateProgress = (
    <div className="flex flex-col gap-2">
      {!micGranted ? (
        micState === "denied" || micState === "restricted" ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-dls-secondary">
              {t("onboarding_setup.mic_denied")}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void store.openPermissionSettings("microphone")}
            >
              {t("onboarding_setup.mic_open_settings")}
            </Button>
          </div>
        ) : (
          <span className="inline-flex items-center gap-2 text-[12px] text-dls-secondary">
            <Loader2 className="size-3.5 animate-spin" />
            {t("onboarding_setup.mic_waiting")}
          </span>
        )
      ) : null}
      {!modelInstalled ? (
        <div className="flex items-center gap-3">
          <Progress value={progress} className="h-1.5 w-40" />
          <span className="text-[12px] tabular-nums text-dls-secondary">
            {t("onboarding_setup.model_preparing", {
              tier: tier ? tierName(tier.key) : "",
              size: sizeMb ? String(sizeMb) : "…",
            })}{" "}
            {modelDownloading ? `${progress}%` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );

  const featureBody = (feature: "dictation" | "recording") => {
    if (!wanted[feature] && !substrateReady) {
      return (
        <Button variant="outline" onClick={() => activate(feature)}>
          {feature === "dictation"
            ? t("onboarding_setup.dictation_enable")
            : t("onboarding_setup.recording_enable")}
        </Button>
      );
    }
    if (!substrateReady) return substrateProgress;
    if (feature === "dictation") {
      return (
        <ReadyLine
          text={
            dictationShortcut
              ? t("onboarding_setup.dictation_ready", { shortcut: dictationShortcut })
              : t("onboarding_setup.dictation_ready_generic")
          }
        />
      );
    }
    return <ReadyLine text={t("onboarding_setup.recording_ready")} />;
  };

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
            <OfficeCard />
            <FeatureCard
              icon={<Sparkles className="size-[18px]" />}
              title={t("onboarding_setup.dictation_title")}
              body={t("onboarding_setup.dictation_body")}
            >
              {featureBody("dictation")}
            </FeatureCard>
            <FeatureCard
              icon={<Mic className="size-[18px]" />}
              title={t("onboarding_setup.recording_title")}
              body={t("onboarding_setup.recording_body")}
            >
              {featureBody("recording")}
            </FeatureCard>
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
