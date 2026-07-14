/** @jsxImportSource react */
/**
 * Compact transcription-model picker for the Recorder pane. Shows the three
 * lawyer-facing tiers (Basic / Standard / Premium) instead of raw model ids,
 * with per-tier install state, a "recommended for your device" hint, and the
 * premium lock. Downloading and selecting happen right from the menu.
 */
import { useState } from "react";
import { Check, ChevronsUpDown, Cpu, Download, Loader2, Lock, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatBytes } from "../../../app/utils";
import { t } from "@/i18n";

import {
  MODEL_TIERS,
  isPremiumEntitled,
  tierForModelId,
  tierName,
  tierTagline,
  type ModelTier,
} from "./model-tiers";
import { useRecorderStore } from "./recorder-store";

/**
 * Gate shown when a locked tier is picked. `reason` chooses the copy: "premium"
 * (needs a paid plan) or "device" (needs a powerful machine). Until auth exists,
 * confirming dismisses the gate so the model stays testable — see `onConfirm`.
 */
export function PremiumUpgradeDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason?: "premium" | "device";
  onConfirm?: () => void;
}) {
  const device = props.reason === "device";
  const Icon = device ? Cpu : Sparkles;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-4 text-primary" />
            {device ? t("recorder.tier_device_title") : t("recorder.tier_premium_unlock")}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {device ? t("recorder.tier_device_hint") : t("recorder.tier_premium_unlock_hint")}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("recorder.model_cancel")}
          </Button>
          <Button
            onClick={() => {
              props.onConfirm?.();
              props.onOpenChange(false);
            }}
          >
            {t("recorder.tier_test_continue")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TierRow(props: {
  tier: ModelTier;
  selected: boolean;
  recommended: boolean;
  onSelect: () => void;
}) {
  const { tier } = props;
  const store = useRecorderStore();
  const entitled = isPremiumEntitled();
  const fastDevice = store.bootstrap?.device?.fastDevice ?? false;
  const model = store.bootstrap?.models.find((entry) => entry.id === tier.modelId);
  const premiumLocked = tier.premium && !entitled;
  const deviceLocked = !!tier.requiresFastDevice && !fastDevice;
  const locked = premiumLocked || deviceLocked;
  const installed = model?.state === "installed";
  const downloading = model?.state === "downloading";
  const size = formatBytes(model?.installedSizeBytes ?? model?.approxSizeBytes ?? 0);

  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted",
        props.selected && "bg-muted",
      )}
    >
      <span className="mt-0.5 w-4 shrink-0">
        {props.selected ? <Check className="size-4 text-primary" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{tierName(tier.key)}</span>
          {tier.premium ? (
            <Badge className="gap-1 text-[10px]">
              <Sparkles className="size-2.5" />
              {t("recorder.tier_premium_locked")}
            </Badge>
          ) : null}
          {tier.requiresFastDevice ? (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <Cpu className="size-2.5" />
              {t("recorder.tier_device_badge")}
            </Badge>
          ) : null}
          {props.recommended ? (
            <Badge variant="outline" className="text-[10px]">
              {t("recorder.tier_recommended_device")}
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{tierTagline(tier.key)}</div>
      </div>
      <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        {locked ? (
          <Lock className="size-3.5" />
        ) : downloading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : installed ? (
          <span className="inline-flex items-center gap-1 text-green-11">
            <Check className="size-3" />
            {t("recorder.model_installed_short")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Download className="size-3" />
            {size}
          </span>
        )}
      </span>
    </button>
  );
}

export function ModelTierSelect(props: { disabled?: boolean }) {
  const store = useRecorderStore();
  const [open, setOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [gateReason, setGateReason] = useState<"premium" | "device">("premium");
  const [pendingTier, setPendingTier] = useState<ModelTier | null>(null);
  const recommendedId = store.bootstrap?.device?.recommendedModelId;
  const fastDevice = store.bootstrap?.device?.fastDevice ?? false;
  const currentTier = tierForModelId(store.modelId) ?? MODEL_TIERS[1];
  const currentModel = store.bootstrap?.models.find((entry) => entry.id === currentTier.modelId);
  const currentInstalled = currentModel?.state === "installed";

  const applyTier = (tier: ModelTier) => {
    store.setModelId(tier.modelId);
    const model = store.bootstrap?.models.find((entry) => entry.id === tier.modelId);
    if (model && model.state !== "installed" && model.state !== "downloading") {
      void store.downloadModel(tier.modelId);
    }
  };

  const pick = (tier: ModelTier) => {
    const premiumLocked = tier.premium && !isPremiumEntitled();
    const deviceLocked = !!tier.requiresFastDevice && !fastDevice;
    if (premiumLocked || deviceLocked) {
      setPendingTier(tier);
      setGateReason(premiumLocked ? "premium" : "device");
      setOpen(false);
      setUpgradeOpen(true);
      return;
    }
    applyTier(tier);
    setOpen(false);
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          disabled={props.disabled}
          render={
            <Button variant="outline" size="sm" className="h-8 min-w-[180px] justify-between">
              <span className="flex items-center gap-2">
                <span className="font-medium">{tierName(currentTier.key)}</span>
                {!currentInstalled ? (
                  <span className="text-[11px] text-muted-foreground">
                    {currentModel?.state === "downloading" ? "…" : t("recorder.model_download_short")}
                  </span>
                ) : null}
              </span>
              <ChevronsUpDown className="size-3.5 opacity-60" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-[320px] p-1.5">
          <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("recorder.model_select_label")}
          </div>
          {MODEL_TIERS.map((tier) => (
            <TierRow
              key={tier.key}
              tier={tier}
              selected={tier.modelId === store.modelId}
              recommended={tier.modelId === recommendedId}
              onSelect={() => pick(tier)}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <PremiumUpgradeDialog
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        reason={gateReason}
        onConfirm={() => {
          store.unlockPremium();
          if (pendingTier) applyTier(pendingTier);
          setPendingTier(null);
        }}
      />
    </>
  );
}
