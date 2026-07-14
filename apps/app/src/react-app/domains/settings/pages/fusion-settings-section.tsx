/** @jsxImportSource react */
import { Blend, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { ModelRef } from "@/app/types";
import { resolveModelDisplayName } from "@/app/utils";
import { ProviderIcon } from "../../../design-system/provider-icon";

export type FusionSettingsSectionProps = {
  fusionModels: ModelRef[];
  /** Opens the model picker for default candidate slot 0-2. */
  onPickModel: (slot: number) => void;
  onClearModel: (slot: number) => void;
};

function ModelSlotRow(props: {
  label: string;
  model: ModelRef | null;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-row flex-wrap items-center justify-between gap-4 px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-3">
        {props.model ? (
          <ProviderIcon providerId={props.model.providerID} size={20} className="text-dls-text" />
        ) : (
          <Blend size={20} className="text-gray-9" />
        )}
        <div className="min-w-0">
          <div className="truncate text-base font-medium text-ink">
            {props.model ? resolveModelDisplayName(props.model.modelID) : t("fusion.settings_no_model")}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {props.model ? `${props.model.providerID}/${props.model.modelID}` : props.label}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={props.onPick}>
          {props.model ? t("fusion.settings_change_model") : t("fusion.settings_select_model")}
        </Button>
        {props.model ? (
          <Button variant="ghost" onClick={props.onClear} aria-label={t("action.remove")}>
            <X size={14} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function FusionSettingsSection(props: FusionSettingsSectionProps) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-ink">{t("fusion.settings_title")}</h3>
        <p className="text-sm text-subtext">{t("fusion.settings_desc")}</p>
      </div>

      <div className="divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-surface shadow-xs">
        {[0, 1, 2].map((slot) => (
          <ModelSlotRow
            key={slot}
            label={t("fusion.settings_model_slot", { index: slot + 1 })}
            model={props.fusionModels[slot] ?? null}
            onPick={() => props.onPickModel(slot)}
            onClear={() => props.onClearModel(slot)}
          />
        ))}
      </div>

      <p className="px-1 text-xs text-subtext">{t("fusion.settings_footnote")}</p>
    </section>
  );
}
