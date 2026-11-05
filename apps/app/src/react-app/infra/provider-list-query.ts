import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { Client, ModelRef, ProviderListItem } from "../../app/types";
import { dispatchNewProviders } from "../../app/lib/provider-events";
import { filterProviderList } from "../../app/utils/providers";
import type { ProviderListView } from "../../app/types";
import { ensureNativeCatalogReady, invalidateNativeCatalogReady } from "../../app/lib/opencode-catalog-ready";
import { createCoalescedRefresh } from "../shell/coalesced-refresh";
import type { NativeProviderDisplay } from "@legalwork/types/native-model-display";

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
  invalidateNativeCatalogReady();
  // Lists of workspaces not on screen are dropped, not kept stale: the reload
  // (or the server reloading those workspaces) may have changed them too, and a
  // stale list would show their models as unavailable when one is opened.
  queryClient.removeQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT, type: "inactive" });
  // invalidateQueries already refetches active observers. Refetching again
  // starts a second full provider enumeration after the first one completes.
  await queryClient.invalidateQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT });
}

export async function fetchProviderList(input: {
  client: Client;
  baseUrl?: string | null;
  directory?: string | null;
}): Promise<ProviderListView> {
  const location = input.directory?.trim() ? { directory: input.directory.trim() } : undefined;
  const models = await ensureNativeCatalogReady(input.client, input.directory?.trim());
  const [providers, modelDefault, integrations, mcp] = await Promise.all([
    input.client.provider.list({ location }),
    input.client.model.default({ location }), input.client.integration.list({ location }),
    input.client.mcp.list({ location }),
  ]);
  const connectorIntegrations = new Set(mcp.data.flatMap(server => server.integrationID ? [server.integrationID] : []));
  const byIntegration = new Map(integrations.data.map(integration => [integration.id, integration]));
  const all: ProviderListItem[] = providers.data.map(provider => {
    const display: typeof provider & NativeProviderDisplay = provider;
    const integration = byIntegration.get(provider.integrationID ?? provider.id);
    return {
      id: provider.id, name: provider.name,
      source: integration?.connections[0]?.type === "env" ? "env" : integration?.connections.length ? "api" : "config",
      settings: provider.settings, integrationID: provider.integrationID, hasCustomEndpoint: display.legalwork?.hasCustomEndpoint,
      env: integration?.methods.flatMap(method => method.type === "env" ? method.names : []) ?? [],
      models: Object.fromEntries(models.data.filter(model => model.providerID === provider.id).map(model => [model.id, model])),
    };
  });
  const known = new Set(all.map(provider => provider.id));
  for (const integration of integrations.data) {
    if (known.has(integration.id) || connectorIntegrations.has(integration.id)) continue;
    all.push({ id: integration.id, name: integration.name, source: "config", models: {}, env: integration.methods.flatMap(method => method.type === "env" ? method.names : []) });
  }
  const value: ProviderListView = {
    all, connected: providers.data.map(provider => provider.id),
    default: modelDefault.data ? { [modelDefault.data.providerID]: modelDefault.data.id } : {},
  };
  recordConnectedProviderSnapshot(input, value);
  return value;
}

export function getConnectedProviderItems(value: ProviderListView | null | undefined) {
  const connected = new Set(value?.connected ?? []);
  return (value?.all ?? []).filter(
    (provider) =>
      connected.has(provider.id) &&
      (provider.source !== "custom" || provider.id === "opencode" || Object.keys(provider.models ?? {}).length > 0),
  );
}

export function getConnectedProviderSnapshot(value: ProviderListView | null | undefined): ConnectedProviderSnapshot {
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
  value: ProviderListView | null | undefined,
  model: ModelRef | null | undefined,
) {
  if (!model?.providerID || !model.modelID) return true;
  return getConnectedProviderItems(value).some(
    (provider) => provider.id === model.providerID && Boolean(provider.models?.[model.modelID]),
  );
}

/**
 * How many providers can serve a model right now, counted from the SAME list
 * `isModelAvailableInConnectedProviders` reads.
 *
 * The composer decides between a red "model no longer available" label and the
 * connect-AI bar (trial / log in / bring your own) from those two answers
 * together, so they must come from one read. Counting a separately-refreshed
 * copy of the connected ids instead made signing out of Eigenwelt flash the
 * label first, while that copy still listed the provider the list had already
 * dropped.
 */
export function countConnectedProviders(
  value: ProviderListView | null | undefined,
  disabledProviderIds: string[] = [],
) {
  if (!value) return 0;
  return getConnectedProviderItems(filterProviderList(value, disabledProviderIds)).length;
}

/** The built-in OpenCode Zen provider id. Retired as a fallback: the server
 * always disables it — no unauthenticated free models exist anymore. */
export const OPENCODE_ZEN_PROVIDER_ID = "opencode";

/** Retired free-tier provider id — kept only so old persisted selections can
 * be recognized and cleared (see the retirement migration in session-route). */
export const RETIRED_FREE_PROVIDER_IDS = new Set(["eigenwelt-free", OPENCODE_ZEN_PROVIDER_ID]);

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
  value: ProviderListView,
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
  return queryClient.fetchQuery({
    ...options,
    staleTime: PROVIDER_LIST_CACHE_MS,
  });
}

/** Consume live events promptly; a slow catalog read must not block chat event subscribers. */
export async function observeProviderCatalog(client: Client, refresh: () => Promise<void>, signal: AbortSignal) {
  const schedule = createCoalescedRefresh(async () => { await refresh(); });
  while (!signal.aborted) {
    try {
      for await (const event of client.event.subscribe({ signal })) {
        if (["server.connected", "model.updated", "provider.updated", "integration.updated", "credential.updated", "credential.switched", "models-dev.refreshed", "config.updated"].includes(event.type)) {
          invalidateNativeCatalogReady(client);
          void schedule().catch(() => {});
        }
      }
    } catch { /* Native streams are live-only; re-subscribe and re-read after reconnection. */ }
    if (!signal.aborted) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, 1000);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}

export function useProviderListQuery(input: {
  client: Client | null;
  baseUrl?: string | null;
  directory?: string | null;
  enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const client = input.client;
    if (!client || input.enabled === false) return;
    const controller = new AbortController();
    const queryKey = providerListQueryKey(input);
    void observeProviderCatalog(client, async () => {
      await queryClient.invalidateQueries({ queryKey, exact: true });
    }, controller.signal);
    return () => controller.abort();
  }, [input.client, input.baseUrl, input.directory, input.enabled, queryClient]);
  return useQuery({
    queryKey: providerListQueryKey(input),
    enabled: Boolean(input.client) && (input.enabled ?? true),
    staleTime: PROVIDER_LIST_CACHE_MS,
    gcTime: PROVIDER_LIST_CACHE_MS,
    queryFn: () => {
      if (!input.client) {
        return {
          all: [],
          connected: [],
          default: {},
        } satisfies ProviderListView;
      }
      return fetchProviderList({
        client: input.client,
        baseUrl: input.baseUrl,
        directory: input.directory,
      });
    },
  });
}
