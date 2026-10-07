import { expect, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import {
  fetchProviderList,
  ensureProviderListQuery,
  PROVIDER_LIST_CACHE_MS,
  providerListQueryKey,
  refreshProviderListQueries,
} from "../src/react-app/infra/provider-list-query";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

/**
 * After an engine reload the provider-auth store re-read the provider list
 * under a cache key without the engine URL, while the composer reads the key
 * with it. Both must share one fresh list after reload and keep different
 * engine endpoints separate, even when their workspace paths match.
 */

const providerList = (connected: string[]): ProviderListResponse =>
  ({
    all: [
      {
        id: "eigenwelt",
        name: "Eigenwelt Subscription",
        env: [],
        source: "config",
        models: { "Eigenwelt Europe": { id: "Eigenwelt Europe", name: "Eigenwelt Europe" } },
      },
    ],
    connected,
    default: {},
  }) as unknown as ProviderListResponse;

test("an engine reload refreshes the provider list the composer reads", async () => {
  // The engine lost the provider; the reload brings it back.
  let engineList = providerList([]);
  let providerCalls = 0;
  const client = {
    provider: { list: async () => { providerCalls += 1; return { data: engineList }; } },
    instance: {
      dispose: async () => {
        engineList = providerList(["eigenwelt"]);
        return { data: true };
      },
    },
    global: { health: async () => ({ data: { healthy: true } }) },
    config: { get: async () => ({ data: {} }) },
  } as unknown as Client;
  const baseUrl = "http://127.0.0.1:4096";
  let currentBaseUrl = baseUrl;
  const directory = "/tmp/workspace";

  // The composer's query (session-route's useProviderListQuery), kept active.
  const composer = new QueryObserver(getReactQueryClient(), {
    queryKey: providerListQueryKey({ baseUrl, directory }),
    queryFn: () => fetchProviderList({ client, baseUrl, directory }),
    staleTime: 5 * 60 * 1000,
  });
  const unsubscribe = composer.subscribe(() => undefined);
  await composer.refetch();
  expect(composer.getCurrentResult().data?.connected).toEqual([]);

  const store = createProviderAuthStore({
    client: () => client,
    baseUrl: () => currentBaseUrl,
    providers: () => [],
    providerDefaults: () => ({}),
    providerConnectedIds: () => [],
    disabledProviders: () => [],
    selectedWorkspaceDisplay: () =>
      ({ id: "ws", name: "Workspace", path: directory, workspaceType: "local" }) as unknown as WorkspaceDisplay,
    selectedWorkspaceRoot: () => directory,
    runtimeWorkspaceId: () => null,
    legalworkServer: {
      getSnapshot: () => ({
        legalworkServerStatus: "disconnected",
        legalworkServerClient: null,
        legalworkServerCapabilities: null,
      }),
    },
    setProviders: () => undefined,
    setProviderDefaults: () => undefined,
    setProviderConnectedIds: () => undefined,
    setDisabledProviders: () => undefined,
    markOpencodeConfigReloadRequired: () => undefined,
  });
  providerCalls = 0;
  await store.refreshProviders({ dispose: true });

  expect(composer.getCurrentResult().data?.connected).toEqual(["eigenwelt"]);
  expect(providerCalls).toBe(1);
  // Returning to settings or opening the picker reuses the same fresh list.
  await store.refreshProviders();
  expect((await ensureProviderListQuery(getReactQueryClient(), { client, baseUrl, directory })).connected).toEqual(["eigenwelt"]);
  expect(providerCalls).toBe(1);
  // A different server can use the same directory name without sharing models.
  currentBaseUrl = "http://127.0.0.1:5096";
  engineList = providerList([]);
  expect((await store.refreshProviders())?.connected).toEqual([]);
  expect(providerCalls).toBe(2);
  expect(composer.getCurrentResult().data?.connected).toEqual(["eigenwelt"]);
  unsubscribe();
});

test("opening the picker fetches an expired cached provider list", async () => {
  const baseUrl = "http://localhost:4097";
  const directory = "/tmp/stale-picker";
  let calls = 0;
  const client = createOpencodeClient({ baseUrl, fetch: async () => {
    calls += 1;
    return Response.json(providerList(["eigenwelt"]));
  } });
  const queryClient = getReactQueryClient();
  queryClient.setQueryData(providerListQueryKey({ baseUrl, directory }), providerList([]), {
    updatedAt: Date.now() - PROVIDER_LIST_CACHE_MS - 1,
  });
  expect((await ensureProviderListQuery(queryClient, { client, baseUrl, directory })).connected).toEqual(["eigenwelt"]);
  await ensureProviderListQuery(queryClient, { client, baseUrl, directory });
  expect(calls).toBe(1);
});

test("an engine reload drops the cached lists of workspaces not on screen", async () => {
  // Cached while another workspace was open, before Eigenwelt was signed in:
  // kept, it would show that workspace's models as unavailable when reopened.
  const otherWorkspace = providerListQueryKey({ baseUrl: "http://127.0.0.1:4096", directory: "/tmp/other" });
  getReactQueryClient().setQueryData(otherWorkspace, providerList([]));

  await refreshProviderListQueries(getReactQueryClient());

  expect(getReactQueryClient().getQueryData(otherWorkspace)).toBeUndefined();
});

test("one refresh enumerates each active provider list only once", async () => {
  const queryClient = getReactQueryClient();
  const key = providerListQueryKey({ baseUrl: "http://localhost:4098", directory: "/tmp/single-refresh" });
  let calls = 0;
  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: async () => { calls += 1; return providerList([]); },
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await observer.refetch();
    calls = 0;
    await refreshProviderListQueries(queryClient);
    expect(calls).toBe(1);
  } finally {
    unsubscribe();
    queryClient.removeQueries({ queryKey: key });
  }
});
