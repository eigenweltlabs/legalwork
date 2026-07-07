/** @jsxImportSource react */
import { useMemo } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { t } from "@/i18n";
import type { ProviderListItem } from "../../../app/types";
import type { BenchmarkModelRef } from "../../../app/lib/benchmark-types";
import { DEFAULT_JUDGE_MODEL } from "../../../app/lib/benchmark-types";
import { ProviderIcon } from "../../design-system/provider-icon";
import { SettingsNotice } from "../settings/settings-section";

export type ModelOption = BenchmarkModelRef & { label: string; providerName: string };

export function buildModelOptions(
  providers: ProviderListItem[],
  providerConnectedIds: string[],
): ModelOption[] {
  const connected = new Set(providerConnectedIds);
  const options: ModelOption[] = [];
  for (const provider of providers) {
    if (!connected.has(provider.id)) continue;
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      const label = (model as { name?: string })?.name?.trim() || modelID;
      options.push({ providerID: provider.id, modelID, label, providerName: provider.name ?? provider.id });
    }
  }
  return options.sort(
    (a, b) => a.providerName.localeCompare(b.providerName) || a.label.localeCompare(b.label),
  );
}

export function defaultJudgeOption(options: ModelOption[]): ModelOption | null {
  return (
    options.find((option) => option.modelID === DEFAULT_JUDGE_MODEL.modelID) ??
    options.find((option) => option.modelID.startsWith(DEFAULT_JUDGE_MODEL.modelID)) ??
    options[0] ??
    null
  );
}

function optionKey(ref: BenchmarkModelRef): string {
  return `${ref.providerID}/${ref.modelID}`;
}

export type ModelSelectStepProps = {
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  selectedModels: BenchmarkModelRef[];
  judge: BenchmarkModelRef | null;
  onToggleModel: (ref: BenchmarkModelRef) => void;
  onSetJudge: (ref: BenchmarkModelRef | null) => void;
};

export function ModelSelectStep(props: ModelSelectStepProps) {
  const options = useMemo(
    () => buildModelOptions(props.providers, props.providerConnectedIds),
    [props.providers, props.providerConnectedIds],
  );
  const byProvider = useMemo(() => {
    const groups = new Map<string, ModelOption[]>();
    for (const option of options) {
      const group = groups.get(option.providerID) ?? [];
      group.push(option);
      groups.set(option.providerID, group);
    }
    return groups;
  }, [options]);
  const selectedKeys = new Set(props.selectedModels.map(optionKey));
  const judgeValue = props.judge ? optionKey(props.judge) : "";

  if (!options.length) {
    return <SettingsNotice>{t("benchmark.no_models_connected")}</SettingsNotice>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div>
        <div className="mb-2 text-[13px] font-medium">{t("benchmark.models_title")}</div>
        <div className="space-y-3">
          {Array.from(byProvider.entries()).map(([providerID, group]) => (
            <div key={providerID} className="rounded-xl border border-dls-border p-3">
              <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
                <ProviderIcon providerId={providerID} size={14} />
                {group[0]?.providerName}
              </div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {group.map((option) => {
                  const key = optionKey(option);
                  return (
                    <label key={key} className="flex cursor-pointer items-center gap-2 text-[13px]">
                      <Checkbox
                        checked={selectedKeys.has(key)}
                        onCheckedChange={() =>
                          props.onToggleModel({ providerID: option.providerID, modelID: option.modelID })
                        }
                      />
                      <span className="truncate" title={option.modelID}>
                        {option.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[13px] font-medium">{t("benchmark.judge_title")}</div>
        <p className="mb-2 text-[12px] text-muted-foreground">{t("benchmark.judge_hint")}</p>
        <Select
          value={judgeValue}
          onValueChange={(value) => {
            const option = options.find((entry) => optionKey(entry) === value);
            props.onSetJudge(option ? { providerID: option.providerID, modelID: option.modelID } : null);
          }}
        >
          <SelectTrigger className="w-full max-w-sm">
            <SelectValue placeholder={DEFAULT_JUDGE_MODEL.modelID} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={optionKey(option)} value={optionKey(option)}>
                <span className="inline-flex items-center gap-2">
                  <ProviderIcon providerId={option.providerID} size={13} />
                  {option.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
