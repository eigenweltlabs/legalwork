/** @jsxImportSource react */
/**
 * Local speech-model management list — lives in Settings → Recorder and is
 * driven by the shared recorder store (download progress arrives over the
 * recorder event bus).
 */
import { useEffect, useState } from "react";
import { Check, Cpu, Download, FolderSearch, HardDrive, Import, Loader2, Lock, Sparkles, Trash2, X } from "lucide-react";

import {
  audioModelImport,
  audioModelsScanExisting,
} from "@/app/lib/desktop";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { formatBytes } from "../../../app/utils";
import { t } from "@/i18n";
import type { AudioModelDiskCandidate, AudioModelState } from "@legalwork/types/audio";

import { isPremiumEntitled, tierForModelId, tierName, tierTagline } from "./model-tiers";
import { PremiumUpgradeDialog } from "./model-tier-select";
import { usePremiumUpsell } from "./premium-upsell-context";
import { useRecorderStore } from "./recorder-store";

function ModelRow(props: { model: AudioModelState; recommended: boolean; selected: boolean }) {
  const { model } = props;
  const store = useRecorderStore();
  const upsell = usePremiumUpsell();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const fastDevice = store.bootstrap?.device?.fastDevice ?? false;
  const unlocked = isPremiumEntitled() || store.unlockedModels.includes(model.id);
  const tier = tierForModelId(model.id);
  const name = tier ? tierName(tier.key) : model.label;
  const tagline = tier ? tierTagline(tier.key) : model.description;
  const isPremium = model.plan === "premium";
  const requiresFastDevice = !!model.requiresFastDevice;
  const premiumLocked = isPremium && !unlocked;
  const deviceLocked = requiresFastDevice && !fastDevice && !unlocked;
  const locked = premiumLocked || deviceLocked;
  const gateReason: "premium" | "device" = premiumLocked ? "premium" : "device";
  const progress =
    model.totalBytes > 0 ? Math.round((model.downloadedBytes / model.totalBytes) * 100) : 0;

  const proceed = () => {
    store.setModelId(model.id);
    if (model.state !== "installed" && model.state !== "downloading") void store.downloadModel(model.id);
  };

  const select = () => {
    // Subscription lock → the shared upsell challenge. Device (hardware) lock →
    // the local testable dialog.
    if (premiumLocked) {
      upsell.open();
      return;
    }
    if (deviceLocked) {
      setUpgradeOpen(true);
      return;
    }
    proceed();
  };

  return (
    <div
      className={cn(
        "rounded-2xl border bg-surface px-3.5 py-3 shadow-xs transition-colors",
        props.selected ? "border-brand ring-1 ring-brand/20" : "border-subtle",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">{name}</span>
            {isPremium ? (
              <Badge className="gap-1 text-2xs">
                <Sparkles className="size-2.5" />
                {t("recorder.tier_premium_locked")}
              </Badge>
            ) : null}
            {requiresFastDevice ? (
              <Badge variant="outline" className="gap-1 text-2xs">
                <Cpu className="size-2.5" />
                {t("recorder.tier_device_badge")}
              </Badge>
            ) : null}
            {props.selected ? (
              <Badge variant="outline" className="gap-1 text-2xs text-brand">
                <Check className="size-3" />
                {t("recorder.model_selected")}
              </Badge>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs text-subtext">{tagline}</div>
          {model.state === "downloading" ? (
            <div className="mt-2 flex items-center gap-2">
              <Progress value={progress} className="h-1.5 flex-1" />
              <span className="text-2xs tabular-nums text-subtext">
                {formatBytes(model.downloadedBytes)} / {formatBytes(model.totalBytes || model.approxSizeBytes)}
              </span>
            </div>
          ) : null}
          {model.state === "error" && model.error ? (
            <div className="mt-1 text-xs text-danger">{model.error}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="text-2xs tabular-nums text-subtext">
            {formatBytes(model.installedSizeBytes ?? model.approxSizeBytes)}
          </span>
          {locked ? (
            <Button variant="outline" size="sm" onClick={() => setUpgradeOpen(true)}>
              <Lock data-icon="inline-start" />
              {premiumLocked ? t("recorder.tier_premium_locked") : t("recorder.tier_device_badge")}
            </Button>
          ) : model.state === "installed" ? (
            <div className="flex items-center gap-1.5">
              {props.selected ? null : (
                <Button variant="outline" size="sm" onClick={() => store.setModelId(model.id)}>
                  {t("recorder.model_use")}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("recorder.model_delete")}
                onClick={() => void store.deleteModel(model.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ) : model.state === "downloading" ? (
            <Button variant="outline" size="sm" onClick={() => void store.cancelModelDownload(model.id)}>
              <X data-icon="inline-start" />
              {t("recorder.model_cancel")}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={select}>
              <Download data-icon="inline-start" />
              {t("recorder.model_download")}
            </Button>
          )}
        </div>
      </div>
      {/* Hardware warning (needs a powerful machine) → testable dialog. The
          subscription lock uses the shared upsell challenge (see `select`). */}
      {deviceLocked ? (
        <PremiumUpgradeDialog
          open={upgradeOpen}
          onOpenChange={setUpgradeOpen}
          reason="device"
          onConfirm={() => {
            store.unlockModelForTesting(model.id);
            proceed();
          }}
        />
      ) : null}
    </div>
  );
}

export function ModelManagerList() {
  const store = useRecorderStore();
  const [diskCandidates, setDiskCandidates] = useState<AudioModelDiskCandidate[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const models = store.bootstrap?.models ?? [];

  const rescan = async () => {
    try {
      setDiskCandidates(await audioModelsScanExisting());
    } catch {
      setDiskCandidates([]);
    }
  };

  useEffect(() => {
    void store.init();
    void rescan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const useDiskCopy = async (candidate: AudioModelDiskCandidate) => {
    setImportBusy(true);
    setImportError(null);
    const result = await audioModelImport(candidate.sourcePath, candidate.modelId);
    setImportBusy(false);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    await Promise.all([store.refreshBootstrap(), rescan()]);
  };

  const recommendedId = store.bootstrap?.device?.recommendedModelId;
  return (
    <div className="space-y-2">
      {models.map((model) => (
        <ModelRow
          key={model.id}
          model={model}
          recommended={model.id === recommendedId}
          selected={model.id === store.modelId}
        />
      ))}

      {diskCandidates.length > 0 ? (
        <div className="rounded-2xl border border-subtle bg-sunken/60 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-ink">
            <FolderSearch className="size-3.5" />
            {t("recorder.models_found_on_disk")}
          </div>
          <div className="mt-1.5 space-y-1.5">
            {diskCandidates.map((candidate) => {
              const entry = models.find((model) => model.id === candidate.modelId);
              return (
                <div key={`${candidate.modelId}-${candidate.sourcePath}`} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-sm text-ink">{entry?.label ?? candidate.modelId}</span>
                    <span className="ml-2 text-xs tabular-nums text-subtext">
                      {formatBytes(candidate.sizeBytes)}
                    </span>
                    <div className="truncate text-2xs text-subtext">{candidate.sourcePath}</div>
                  </div>
                  <Button size="sm" variant="outline" disabled={importBusy} onClick={() => void useDiskCopy(candidate)}>
                    {importBusy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Import data-icon="inline-start" />}
                    {t("recorder.model_use_local")}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {importError ? <div className="text-xs text-danger">{importError}</div> : null}
    </div>
  );
}
