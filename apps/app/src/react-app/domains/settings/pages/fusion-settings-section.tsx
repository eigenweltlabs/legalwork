/** @jsxImportSource react */
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { ModelRef } from "@/app/types";
import { resolveModelDisplayName } from "@/app/utils";
import { ProviderIcon } from "../../../design-system/provider-icon";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemFootnote,
  LayoutSectionTitle,
} from "../settings-layout";

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
    <LayoutSectionItem className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {props.model ? (
          <ProviderIcon providerId={props.model.providerID} size={20} className="text-dls-text" />
        ) : (
          <Sparkles size={20} className="text-gray-9" />
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-dls-text">
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
    </LayoutSectionItem>
  );
}

export function FusionSettingsSection(props: FusionSettingsSectionProps) {
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("fusion.settings_title")}</LayoutSectionTitle>
        <LayoutSectionDescription>{t("fusion.settings_desc")}</LayoutSectionDescription>
      </LayoutSectionHeader>

      {[0, 1, 2].map((slot) => (
        <ModelSlotRow
          key={slot}
          label={t("fusion.settings_model_slot", { index: slot + 1 })}
          model={props.fusionModels[slot] ?? null}
          onPick={() => props.onPickModel(slot)}
          onClear={() => props.onClearModel(slot)}
        />
      ))}

      <LayoutSectionItemFootnote>{t("fusion.settings_footnote")}</LayoutSectionItemFootnote>
    </LayoutSection>
  );
}
