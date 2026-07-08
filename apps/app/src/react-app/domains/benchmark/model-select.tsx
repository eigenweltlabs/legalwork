/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
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

function matchesSearch(option: ModelOption, query: string): boolean {
  if (!query) return true;
  const haystack = `${option.label} ${option.modelID} ${option.providerName}`.toLowerCase();
  return haystack.includes(query);
}

function providerList(options: ModelOption[]): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>();
  for (const option of options) {
    if (!byId.has(option.providerID)) byId.set(option.providerID, option.providerName);
  }
  return Array.from(byId.entries()).map(([id, name]) => ({ id, name }));
}

const ALL_PROVIDERS = "__all__";

/** Shared popover shell: a search box, an optional provider filter, and a scrollable list. */
function PickerPopover(props: {
  triggerLabel: React.ReactNode;
  providers: Array<{ id: string; name: string }>;
  options: ModelOption[];
  renderRow: (option: ModelOption, close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>(ALL_PROVIDERS);
  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      props.options.filter(
        (option) =>
          (providerFilter === ALL_PROVIDERS || option.providerID === providerFilter) &&
          matchesSearch(option, query),
      ),
    [props.options, providerFilter, query],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" className="w-full max-w-sm justify-between">
            <span className="min-w-0 truncate">{props.triggerLabel}</span>
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[min(30rem,92vw)] p-0">
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={search}
            placeholder={t("benchmark.search_models")}
            className="w-full bg-transparent text-[13px] outline-none"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {props.providers.length > 1 ? (
          <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
            <button
              type="button"
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px]",
                providerFilter === ALL_PROVIDERS ? "bg-foreground text-background" : "text-muted-foreground hover:bg-dls-hover",
              )}
              onClick={() => setProviderFilter(ALL_PROVIDERS)}
            >
              {t("benchmark.all_providers")}
            </button>
            {props.providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                  providerFilter === provider.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-dls-hover",
                )}
                onClick={() => setProviderFilter(provider.id)}
              >
                <ProviderIcon providerId={provider.id} size={11} />
                {provider.name}
              </button>
            ))}
          </div>
        ) : null}
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">—</div>
          ) : (
            filtered.map((option) => props.renderRow(option, () => setOpen(false)))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
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
  const providers = useMemo(() => providerList(options), [options]);
  const optionByKey = useMemo(() => new Map(options.map((option) => [optionKey(option), option])), [options]);
  const selectedKeys = useMemo(() => new Set(props.selectedModels.map(optionKey)), [props.selectedModels]);
  const judgeOption = props.judge ? optionByKey.get(optionKey(props.judge)) : null;

  if (!options.length) {
    return <SettingsNotice>{t("benchmark.no_models_connected")}</SettingsNotice>;
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Models — compact popover trigger + chips; the list scrolls inside the popover. */}
      <div>
        <div className="mb-2 flex items-center justify-between text-[13px] font-medium">
          <span>{t("benchmark.models_title")}</span>
          {props.selectedModels.length ? (
            <span className="text-[11px] font-normal text-muted-foreground">
              {t("benchmark.selected_count", { count: props.selectedModels.length })}
            </span>
          ) : null}
        </div>

        <PickerPopover
          triggerLabel={
            props.selectedModels.length
              ? t("benchmark.selected_count", { count: props.selectedModels.length })
              : t("benchmark.select_models")
          }
          providers={providers}
          options={options}
          renderRow={(option) => {
            const key = optionKey(option);
            return (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-dls-hover"
              >
                <Checkbox
                  checked={selectedKeys.has(key)}
                  onCheckedChange={() =>
                    props.onToggleModel({ providerID: option.providerID, modelID: option.modelID })
                  }
                />
                <ProviderIcon providerId={option.providerID} size={13} />
                <span className="min-w-0 flex-1 truncate" title={option.modelID}>
                  {option.label}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{option.providerName}</span>
              </label>
            );
          }}
        />

        {props.selectedModels.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {props.selectedModels.map((model) => {
              const option = optionByKey.get(optionKey(model));
              return (
                <Badge key={optionKey(model)} variant="secondary" className="gap-1 px-1.5 py-0.5 text-[11px]">
                  <ProviderIcon providerId={model.providerID} size={11} />
                  <span className="max-w-40 truncate">{option?.label ?? model.modelID}</span>
                  <button type="button" onClick={() => props.onToggleModel(model)}>
                    <X size={11} />
                  </button>
                </Badge>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Judge — always visible directly below, single-select popover. */}
      <div>
        <div className="mb-1 text-[13px] font-medium">{t("benchmark.judge_title")}</div>
        <p className="mb-2 text-[12px] text-muted-foreground">{t("benchmark.judge_hint")}</p>
        <PickerPopover
          triggerLabel={
            <span className="inline-flex min-w-0 items-center gap-2">
              {props.judge ? <ProviderIcon providerId={props.judge.providerID} size={13} /> : null}
              <span className="truncate">
                {judgeOption?.label ?? props.judge?.modelID ?? DEFAULT_JUDGE_MODEL.modelID}
              </span>
            </span>
          }
          providers={providers}
          options={options}
          renderRow={(option, close) => {
            const key = optionKey(option);
            const active = props.judge ? optionKey(props.judge) === key : false;
            return (
              <button
                key={key}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-dls-hover",
                  active && "bg-dls-hover",
                )}
                onClick={() => {
                  props.onSetJudge({ providerID: option.providerID, modelID: option.modelID });
                  close();
                }}
              >
                <ProviderIcon providerId={option.providerID} size={13} />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{option.providerName}</span>
                {active ? <Check size={14} className="shrink-0 text-primary" /> : null}
              </button>
            );
          }}
        />
      </div>
    </div>
  );
}
