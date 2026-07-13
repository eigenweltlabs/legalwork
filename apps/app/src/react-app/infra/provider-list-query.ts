import { useQuery, type QueryClient } from "@tanstack/react-query";

import type { Client, ModelRef, ProviderListItem } from "../../app/types";
import { unwrap } from "../../app/lib/opencode";
import { dispatchNewProviders } from "../../app/lib/provider-events";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

export const PROVIDER_LIST_CACHE_MS = 5 * 60 * 1000;
const PROVIDER_LIST_QUERY_ROOT = ["opencode-provider-list"] as const;

export type ConnectedProviderSnapshot = Array<{
  id: string;
  name: string;
  source: ProviderListItem["source"];
  models: Record<string, ProviderListItem["models"][string]>;
}>;

export type ConnectedProviderSnapshotChange = {
  changed: boolean;
  previous: ConnectedProviderSnapshot | null;
  next: ConnectedProviderSnapshot;
};

const connectedProviderSnapshots = new Map<string, ConnectedProviderSnapshot>();
const connectedProviderSnapshotChanges = new Map<string, ConnectedProviderSnapshotChange>();

export function providerListQueryKey(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return [
    ...PROVIDER_LIST_QUERY_ROOT,
    input.baseUrl?.trim() ?? "",
    input.directory?.trim() ?? "",
  ] as const;
}

export async function refreshProviderListQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT });
  await queryClient.refetchQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT, type: "active" });
}

export async function fetchProviderList(input: {
  client: Client;
  baseUrl?: string | null;
  directory?: string | null;
}): Promise<ProviderListResponse> {
  const value = unwrap(
    await input.client.provider.list({
      directory: input.directory?.trim() || undefined,
    }),
  );
  recordConnectedProviderSnapshot(input, value);
  return value;
}

export function getConnectedProviderItems(value: ProviderListResponse | null | undefined) {
  const connected = new Set(value?.connected ?? []);
  return (value?.all ?? []).filter(
    (provider) =>
      connected.has(provider.id) &&
      (provider.source !== "custom" || provider.id === "opencode" || Object.keys(provider.models ?? {}).length > 0),
  );
}

export function getConnectedProviderSnapshot(value: ProviderListResponse | null | undefined): ConnectedProviderSnapshot {
  return getConnectedProviderItems(value)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: provider.source,
      models: Object.fromEntries(
        Object.entries(provider.models ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function isModelAvailableInConnectedProviders(
  value: ProviderListResponse | null | undefined,
  model: ModelRef | null | undefined,
) {
  if (!model?.providerID || !model.modelID) return true;
  return getConnectedProviderItems(value).some(
    (provider) => provider.id === model.providerID && Boolean(provider.models?.[model.modelID]),
  );
}

/** The built-in OpenCode Zen provider id (its free tier works without a key). */
export const OPENCODE_ZEN_PROVIDER_ID = "opencode";

/** The Eigenwelt free-tier provider the server injects when the platform's
 * free-models manifest is available (no login). Zen is disabled while it is. */
export const EIGENWELT_FREE_PROVIDER_ID = "eigenwelt-free";

/**
 * True when `model` is a *free-tier* model — the no-key models the app falls
 * back to when no paid provider is configured. Usage data is logged for
 * free-tier requests (Eigenwelt free gateway) or may be retained (OpenCode
 * Zen, the fallback when the Eigenwelt platform is unreachable), so the UI
 * warns before they're used with privileged, client, or matter data.
 *
 * Every model on the `eigenwelt-free` provider is free by definition. For the
 * built-in `opencode` provider only zero-cost models count, so genuinely-
 * private zero-cost models (local Ollama / LM Studio endpoints) are NOT
 * mistaken for free-tier models and paid Zen models are excluded too.
 */
export function isFreeOpencodeModel(
  value: ProviderListResponse | null | undefined,
  model: ModelRef | null | undefined,
): boolean {
  if (!model?.providerID || !model.modelID) return false;
  const providerId = model.providerID.trim().toLowerCase();
  if (providerId === EIGENWELT_FREE_PROVIDER_ID) return true;
  if (providerId !== OPENCODE_ZEN_PROVIDER_ID) return false;
  const provider = getConnectedProviderItems(value).find((entry) => entry.id === model.providerID);
  const cost = provider?.models?.[model.modelID]?.cost;
  if (!cost) return false;
  return (cost.input ?? 0) === 0 && (cost.output ?? 0) === 0;
}

/**
 * One-time free-tier migration for existing installs. Older installs
 * persisted their selected/default model on the engine's built-in OpenCode
 * Zen provider (`opencode`). When the server starts injecting the
 * `eigenwelt-free` provider it also disables zen, which would strand that
 * persisted selection behind a permanent "model no longer available" state.
 *
 * Returns the replacement ModelRef — the free provider's first model — when
 * ALL of these hold, and null otherwise:
 *  - the persisted model sits on the zen provider,
 *  - zen no longer serves it (disabled providers drop out of `connected`),
 *  - `eigenwelt-free` is connected and has at least one model.
 *
 * Null on an unloaded provider list, so callers can run it on every
 * provider-list load: once the selection is remapped (or the user picks any
 * non-zen model) the first condition fails and this is a no-op — idempotent
 * by construction.
 */
export function remapZenSelectionToEigenweltFree(
  value: ProviderListResponse | null | undefined,
  model: ModelRef | null | undefined,
): ModelRef | null {
  if (!value) return null;
  if (!model?.providerID || !model.modelID) return null;
  if (model.providerID.trim().toLowerCase() !== OPENCODE_ZEN_PROVIDER_ID) return null;
  if (isModelAvailableInConnectedProviders(value, model)) return null;
  const free = getConnectedProviderItems(value).find(
    (provider) => provider.id === EIGENWELT_FREE_PROVIDER_ID,
  );
  const firstModelId = Object.keys(free?.models ?? {})[0];
  if (!firstModelId) return null;
  return { providerID: EIGENWELT_FREE_PROVIDER_ID, modelID: firstModelId };
}

export function getConnectedProviderSnapshotChange(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return connectedProviderSnapshotChanges.get(connectedProviderSnapshotKey(input)) ?? null;
}

function recordConnectedProviderSnapshot(
  input: {
    baseUrl?: string | null;
    directory?: string | null;
  },
  value: ProviderListResponse,
) {
  const key = connectedProviderSnapshotKey(input);
  const previous = connectedProviderSnapshots.get(key) ?? null;
  const next = getConnectedProviderSnapshot(value);
  const changed = previous !== null && JSON.stringify(previous) !== JSON.stringify(next);
  connectedProviderSnapshots.set(key, next);
  connectedProviderSnapshotChanges.set(key, { changed, previous, next });
  if (changed) {
    dispatchConnectedProviderChanges(previous, next);
  }
}

function connectedProviderSnapshotKey(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return JSON.stringify(providerListQueryKey(input));
}

function dispatchConnectedProviderChanges(
  previous: ConnectedProviderSnapshot | null,
  next: ConnectedProviderSnapshot,
) {
  if (!previous) return;
  const previousById = new Map(previous.map((provider) => [provider.id, provider]));
  const newProviders = next.filter((provider) => !previousById.has(provider.id));
  const changedProviders = new Map<string, ConnectedProviderSnapshot[number]>();
  let newModelCount = 0;

  for (const provider of next) {
    const before = previousById.get(provider.id);
    if (!before) {
      newModelCount += Object.keys(provider.models).length;
      changedProviders.set(provider.id, provider);
      continue;
    }
    for (const [id, model] of Object.entries(provider.models)) {
      if (JSON.stringify(before.models[id]) !== JSON.stringify(model)) {
        newModelCount += 1;
        changedProviders.set(provider.id, provider);
      }
    }
  }

  if (newProviders.length === 0 && newModelCount === 0) return;

  dispatchNewProviders({
    providers: [...changedProviders.values()].map((provider) => {
      const firstModelId = Object.keys(provider.models)[0];
      return {
        id: provider.id,
        name: provider.name,
        providerId: provider.id,
        firstModelId,
        firstModelName: firstModelId ? provider.models[firstModelId]?.name ?? firstModelId : undefined,
      };
    }),
    newProviderCount: newProviders.length,
    newModelCount,
    source: "models_refresh",
  });
}

export function ensureProviderListQuery(
  queryClient: QueryClient,
  input: {
    client: Client;
    baseUrl?: string | null;
    directory?: string | null;
    force?: boolean;
  },
) {
  const options = {
    queryKey: providerListQueryKey(input),
    queryFn: () => fetchProviderList(input),
    gcTime: PROVIDER_LIST_CACHE_MS,
  };
  if (input.force) {
    return queryClient.fetchQuery({
      ...options,
      staleTime: 0,
    });
  }
  return queryClient.ensureQueryData({
    ...options,
    staleTime: PROVIDER_LIST_CACHE_MS,
  });
}

export function useProviderListQuery(input: {
  client: Client | null;
  baseUrl?: string | null;
  directory?: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: providerListQueryKey(input),
    enabled: Boolean(input.client) && (input.enabled ?? true),
    staleTime: PROVIDER_LIST_CACHE_MS,
    gcTime: PROVIDER_LIST_CACHE_MS,
    queryFn: () => {
      if (!input.client) {
        return {
          all: [] as ProviderListItem[],
          connected: [],
          default: {},
        } satisfies ProviderListResponse;
      }
      return fetchProviderList({
        client: input.client,
        baseUrl: input.baseUrl,
        directory: input.directory,
      });
    },
  });
}
