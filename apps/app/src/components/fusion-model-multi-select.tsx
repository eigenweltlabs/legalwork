"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import type { ModelOption, ModelRef } from "@/app/types";
import { t } from "@/i18n";
import { MAX_FUSION_MODELS } from "@/react-app/domains/session/fusion/fusion-store";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandHeader,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useModelOptions } from "./model-select";

type MultiSelectItem = {
  kind: "model";
  id: string;
  option: ModelOption;
};

type MultiSelectGroup = {
  value: string;
  items: MultiSelectItem[];
};

function groupByProvider(modelOptions: ModelOption[]): MultiSelectGroup[] {
  const groups = new Map<string, MultiSelectItem[]>();
  for (const option of modelOptions) {
    const providerLabel = option.description ?? option.providerID;
    const item: MultiSelectItem = {
      kind: "model",
      id: `${option.providerID}:${option.modelID}`,
      option,
    };
    const existing = groups.get(providerLabel);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(providerLabel, [item]);
    }
  }
  return [...groups.entries()]
    .map(([providerLabel, options]) => ({
      value: providerLabel,
      items: [...options].sort((a, b) => a.option.title.localeCompare(b.option.title)),
    }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function refKey(model: ModelRef) {
  return `${model.providerID}:${model.modelID}`;
}

interface FusionModelMultiSelectProps {
  selected: ModelRef[];
  onChange: (models: ModelRef[]) => void;
  disabled?: boolean;
}

/**
 * Multi-select picker for the fusion candidate models (up to 3), shown in the
 * composer while fusion mode is on. The session's regular model picker stays
 * the main/fusion model.
 */
export function FusionModelMultiSelect({ selected, onChange, disabled = false }: FusionModelMultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const modelOptions = useModelOptions(open);

  const selectedKeys = React.useMemo(() => new Set(selected.map(refKey)), [selected]);
  const groups = React.useMemo(() => groupByProvider(modelOptions), [modelOptions]);

  const toggle = (option: ModelOption) => {
    const ref: ModelRef = { providerID: option.providerID, modelID: option.modelID };
    if (selectedKeys.has(refKey(ref))) {
      onChange(selected.filter((model) => refKey(model) !== refKey(ref)));
      return;
    }
    if (selected.length >= MAX_FUSION_MODELS) return;
    onChange([...selected, ref]);
  };

  const label = selected.length > 0
    ? t("fusion.models_count", { count: selected.length })
    : t("fusion.choose_models");

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              type="button"
              disabled={disabled}
              aria-label={t("fusion.choose_models")}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-60"
            />
          }
        >
          <span className="max-w-48 truncate">{label}</span>
          <ChevronDown className="h-3 w-3" />
        </TooltipTrigger>
        <TooltipContent>{t("fusion.multiselect_tooltip")}</TooltipContent>
      </Tooltip>
      <PopoverContent
        className="h-80 max-h-(--available-height) w-72 gap-0 overflow-hidden p-px **:data-[slot=scroll-area-viewport]:data-has-overflow-y:pe-0.5"
        align="start"
        initialFocus={false}
      >
        <Command items={groups} value={search} onValueChange={setSearch}>
          <CommandHeader>
            <CommandInput placeholder={t("fusion.multiselect_search")} />
          </CommandHeader>
          <CommandEmpty>{t("fusion.multiselect_empty")}</CommandEmpty>
          <CommandList>
            {(group: MultiSelectGroup) => (
              <CommandGroup key={group.value} items={group.items}>
                <CommandGroupLabel>{group.value}</CommandGroupLabel>
                <CommandCollection>
                  {(item: MultiSelectItem) => {
                    const option = item.option;
                    const isSelected = selectedKeys.has(item.id);
                    const atCapacity = !isSelected && selected.length >= MAX_FUSION_MODELS;
                    return (
                      <CommandItem
                        className={`gap-2 ${atCapacity ? "opacity-50" : ""}`}
                        key={item.id}
                        value={`${option.providerID}:${option.modelID} ${option.title} ${option.description ?? ""}`}
                        onClick={() => toggle(option)}
                      >
                        <span
                          className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                            isSelected ? "border-[var(--dls-accent)] bg-[var(--dls-accent)] text-[var(--dls-accent-fg)]" : "border-gray-7"
                          }`}
                        >
                          {isSelected ? <Check className="size-3" /> : null}
                        </span>
                        <ProviderIcon
                          providerId={option.providerID}
                          providerName={option.description}
                          className="size-3.5 opacity-70"
                          size={14}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-foreground">{option.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {option.description ?? option.providerID}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  }}
                </CommandCollection>
              </CommandGroup>
            )}
          </CommandList>
          <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {t("fusion.multiselect_footer", { count: selected.length, max: MAX_FUSION_MODELS })}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
