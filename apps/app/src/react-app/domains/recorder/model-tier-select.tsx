/** @jsxImportSource react */
/**
 * Compact transcription-model picker for the Recorder pane. Shows the
 * lawyer-facing tiers instead of raw model ids, with a "recommended for your
 * device" hint. Only installed models are selectable inline; tiers that aren't
 * downloaded yet are greyed and route to Settings > Recorder to install them
 * (no silent download). The premium/device gate lives there too.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronsUpDown, Cpu, Download, Loader2, Sparkles } from "lucide-react";

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
            <Icon className="size-4 text-brand" />
            {device ? t("recorder.tier_device_title") : t("recorder.tier_premium_unlock")}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm leading-relaxed text-subtext">
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
  const model = store.bootstrap?.models.find((entry) => entry.id === tier.modelId);
  const installed = model?.state === "installed";
  const downloading = model?.state === "downloading";
  const size = formatBytes(model?.installedSizeBytes ?? model?.approxSizeBytes ?? 0);

  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-hover",
        props.selected && "bg-sunken",
        // Not-yet-downloaded tiers read as unavailable; clicking one routes to
        // Settings to install it rather than downloading inline.
        !installed && !downloading && "opacity-55",
      )}
    >
      <span className="mt-0.5 w-4 shrink-0">
        {props.selected ? <Check className="size-4 text-brand" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-ink">{tierName(tier.key)}</span>
          {tier.premium ? (
            <Badge className="gap-1 text-2xs">
              <Sparkles className="size-2.5" />
              {t("recorder.tier_premium_locked")}
            </Badge>
          ) : null}
          {tier.requiresFastDevice ? (
            <Badge variant="outline" className="gap-1 text-2xs">
              <Cpu className="size-2.5" />
              {t("recorder.tier_device_badge")}
            </Badge>
          ) : null}
          {props.recommended ? (
            <Badge variant="outline" className="text-2xs">
              {t("recorder.tier_recommended_device")}
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs text-subtext">{tierTagline(tier.key)}</div>
      </div>
      <span className="mt-0.5 flex shrink-0 items-center gap-1.5 text-2xs text-subtext">
        {downloading ? (
          <Loader2 className="size-3.5 animate-spin text-brand" />
        ) : installed ? (
          <span className="inline-flex items-center gap-1 text-success">
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
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const recommendedId = store.bootstrap?.device?.recommendedModelId;
  // null when the user hasn't picked a model yet — the trigger shows a
  // "choose a model" placeholder and recording stays disabled until they do.
  const selectedTier = tierForModelId(store.modelId);
  const currentModel = selectedTier
    ? store.bootstrap?.models.find((entry) => entry.id === selectedTier.modelId)
    : undefined;
  const currentInstalled = currentModel?.state === "installed";

  const pick = (tier: ModelTier) => {
    const model = store.bootstrap?.models.find((entry) => entry.id === tier.modelId);
    // Only installed models switch inline. Anything not downloaded yet sends the
    // user to Settings > Recorder to install it (and clear any gate) — never a
    // silent background download from here.
    if (model?.state !== "installed") {
      setOpen(false);
      navigate("/settings/recorder");
      return;
    }
    store.setModelId(tier.modelId);
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          disabled={props.disabled}
          render={
            <Button variant="outline" size="sm" className="h-8 min-w-[180px] justify-between">
              <span className="flex items-center gap-2">
                {selectedTier ? (
                  <>
                    <span className="font-medium text-ink">{tierName(selectedTier.key)}</span>
                    {!currentInstalled ? (
                      <span className="text-2xs text-subtext">
                        {currentModel?.state === "downloading" ? "…" : t("recorder.model_download_short")}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="font-medium text-subtext">
                    {t("recorder.model_select_placeholder")}
                  </span>
                )}
              </span>
              <ChevronsUpDown className="size-3.5 opacity-60" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-[320px] rounded-2xl p-1.5">
          <div className="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wide text-tertiary">
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
  );
}
