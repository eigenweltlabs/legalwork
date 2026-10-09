// Model picker state with live provider inventory and new-provider toast triggers.
import { useEffect, useEffectEvent, useState } from "react";

import type { Client, ModelOption } from "@/app/types";
import { modelDisplayName } from "@/app/utils/models";
import {
  useProviderListQuery,
  getConnectedProviderItems,
} from "@/react-app/infra/provider-list-query";
import {
  openModelPickerEvent,
  pendingModelPickerProviderIdsKey,
} from "@/react-app/shell/new-providers-listener";

export type UseModelPickerInput = {
  client: Client | null;
  baseUrl: string;
  workspaceRoot: string;
  listenForDefaults?: boolean;
  /** Optional: surface option-load failures (settings shows a toast; the session route stays silent). */
  onLoadError?: (error: unknown) => void;
};

export function useModelPicker(input: UseModelPickerInput) {
  const { client, baseUrl, workspaceRoot, onLoadError } = input;

  const [open, setOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  // Provider IDs that were just added — used to highlight them as
  // "Recently added" in the model picker even after they've been
  // marked as seen in localStorage.
  const [recentProviderIds, setRecentProviderIds] = useState<Set<string>>(new Set());
  const providerQuery = useProviderListQuery({ client, baseUrl, directory: workspaceRoot || undefined, enabled: open || compactOpen });

  // Open model picker when the global toast's "Pick a new default?" is clicked
  useEffect(() => {
    if (input.listenForDefaults === false) return;
    const handler = (event: Event) => {
      try {
        window.localStorage.removeItem(pendingModelPickerProviderIdsKey);
      } catch {}
      const detail = (event as CustomEvent<{ newProviderIds?: string[]; initialTab?: "default" | "available" }>).detail;
      const ids = detail?.newProviderIds;
      if (ids && ids.length > 0) {
        setRecentProviderIds(new Set(ids));
      }
      setOpen(true);
    };
    window.addEventListener(openModelPickerEvent, handler);
    return () => window.removeEventListener(openModelPickerEvent, handler);
  }, [input.listenForDefaults]);

  useEffect(() => {
    if (input.listenForDefaults === false) return;
    try {
      const raw = window.localStorage.getItem(pendingModelPickerProviderIdsKey);
      if (!raw) return;
      window.localStorage.removeItem(pendingModelPickerProviderIdsKey);
      const parsed = JSON.parse(raw);
      const ids = Array.isArray(parsed) ? parsed : parsed?.newProviderIds;
      if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
        setRecentProviderIds(new Set(ids));
      }
      setOpen(true);
    } catch {
      // Ignore malformed pending-picker state.
    }
  }, [input.listenForDefaults]);

  // Observe the cache so models discovered while the picker is open appear immediately.
  useEffect(() => {
    const data = providerQuery.data;
    if (!data?.all) { setModelOptions([]); return; }
    // Flag models from recently-added providers so they appear in
    // the "Recently added" section at the top of the picker.
    // Two sources: (1) providers not yet in the localStorage seen-set,
    // (2) providers passed via the openModelPickerEvent from the toast.
    let seenIds: Set<string>;
    try {
      const raw = window.localStorage.getItem("legalwork.seenProviderIds");
      seenIds = new Set(raw ? JSON.parse(raw) : []);
    } catch {
      seenIds = new Set();
    }
    const options: ModelOption[] = [];
    for (const provider of getConnectedProviderItems(data)) {
      const modelIds = Object.keys(provider.models);
      const isNew = !seenIds.has(provider.id) || recentProviderIds.has(provider.id);
      for (const id of modelIds) {
        const model = provider.models[id];
        options.push({
          providerID: provider.id,
          modelID: id,
          title: modelDisplayName(id, model.name),
          description: provider.name,
          behaviorTitle: "Reasoning",
          behaviorLabel: "Default",
          behaviorDescription: "",
          behaviorValue: null,
          isFree: false,
          isConnected: true,
          isRecommended: isNew,
          source: /^lpr_/i.test(provider.id) ? "cloud" as const : undefined,
        });
      }
    }
    setModelOptions(options);
  }, [providerQuery.data, recentProviderIds]);

  const reportError = useEffectEvent((error: unknown) => onLoadError?.(error));
  useEffect(() => {
    if (providerQuery.error) reportError(providerQuery.error);
  }, [providerQuery.error]);

  // Org-level provider restrictions were removed with the cloud backend;
  // surface every connected provider model.
  const options = modelOptions;

  return {
    open,
    setOpen,
    compactOpen,
    setCompactOpen,
    query,
    setQuery,
    options,
    setRecentProviderIds,
  };
}
