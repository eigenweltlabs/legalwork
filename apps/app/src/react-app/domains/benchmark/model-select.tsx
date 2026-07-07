/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

/** Connected providers that actually expose models, for the provider filter. */
function providerList(options: ModelOption[]): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>();
  for (const option of options) {
    if (!byId.has(option.providerID)) byId.set(option.providerID, option.providerName);
  }
  return Array.from(byId.entries()).map(([id, name]) => ({ id, name }));
}

const ALL_PROVIDERS = "__all__";

function JudgePicker(props: {
  options: ModelOption[];
  judge: BenchmarkModelRef | null;
  onSetJudge: (ref: BenchmarkModelRef | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = props.judge ? props.options.find((option) => optionKey(option) === optionKey(props.judge!)) : null;
  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () => props.options.filter((option) => matchesSearch(option, query)),
    [props.options, query],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" className="w-full max-w-sm justify-between">
            <span className="inline-flex min-w-0 items-center gap-2">
              {props.judge ? <ProviderIcon providerId={props.judge.providerID} size={13} /> : null}
              <span className="truncate">{selected?.label ?? props.judge?.modelID ?? DEFAULT_JUDGE_MODEL.modelID}</span>
            </span>
            <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[min(28rem,90vw)] p-0">
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
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">—</div>
          ) : (
            filtered.map((option) => {
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
                    setOpen(false);
                  }}
                >
                  <ProviderIcon providerId={option.providerID} size={13} />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{option.providerName}</span>
                  {active ? <Check size={14} className="shrink-0 text-primary" /> : null}
                </button>
              );
            })
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
  const [providerFilter, setProviderFilter] = useState<string>(ALL_PROVIDERS);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  const selectedKeys = useMemo(() => new Set(props.selectedModels.map(optionKey)), [props.selectedModels]);
  const optionByKey = useMemo(() => new Map(options.map((option) => [optionKey(option), option])), [options]);

  const filtered = useMemo(
    () =>
      options.filter(
        (option) =>
          (providerFilter === ALL_PROVIDERS || option.providerID === providerFilter) &&
          matchesSearch(option, query),
      ),
    [options, providerFilter, query],
  );

  if (!options.length) {
    return <SettingsNotice>{t("benchmark.no_models_connected")}</SettingsNotice>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div>
        <div className="mb-2 flex items-center justify-between text-[13px] font-medium">
          <span>{t("benchmark.models_title")}</span>
          {props.selectedModels.length ? (
            <span className="text-[11px] font-normal text-muted-foreground">
              {t("benchmark.selected_count", { count: props.selectedModels.length })}
            </span>
          ) : null}
        </div>

        {/* Selected models as removable chips, visible regardless of the current filter. */}
        {props.selectedModels.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
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

        <div className="rounded-xl border border-dls-border">
          {/* Provider filter + search — the two-level entry into a long model list. */}
          <div className="flex items-center gap-2 border-b border-border p-2">
            <Select value={providerFilter} onValueChange={(value) => setProviderFilter(value ?? ALL_PROVIDERS)}>
              <SelectTrigger className="h-8 w-44 shrink-0 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROVIDERS}>{t("benchmark.all_providers")}</SelectItem>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    <span className="inline-flex items-center gap-1.5">
                      <ProviderIcon providerId={provider.id} size={12} />
                      {provider.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <Search size={14} className="shrink-0 text-muted-foreground" />
              <input
                value={search}
                placeholder={t("benchmark.search_models")}
                className="w-full bg-transparent text-[13px] outline-none"
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">—</div>
            ) : (
              filtered.map((option) => {
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
                    {providerFilter === ALL_PROVIDERS ? (
                      <ProviderIcon providerId={option.providerID} size={13} />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate" title={option.modelID}>
                      {option.label}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 text-[13px] font-medium">{t("benchmark.judge_title")}</div>
        <p className="mb-2 text-[12px] text-muted-foreground">{t("benchmark.judge_hint")}</p>
        <JudgePicker options={options} judge={props.judge} onSetJudge={props.onSetJudge} />
      </div>
    </div>
  );
}
