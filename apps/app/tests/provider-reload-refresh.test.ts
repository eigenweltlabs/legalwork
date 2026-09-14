import { expect, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";

import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { Client, WorkspaceDisplay } from "../src/app/types";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import {
  fetchProviderList,
  providerListQueryKey,
  refreshProviderListQueries,
} from "../src/react-app/infra/provider-list-query";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

/**
 * After an engine reload the provider-auth store re-read the provider list
 * under a cache key without the engine URL, while the composer reads the key
 * with it. The composer kept the list from before the reload, so "Model no
 * longer available" stayed up until the window was reloaded — even though the
 * reload had brought the Eigenwelt models back.
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
  const client = {
    provider: { list: async () => ({ data: engineList }) },
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
  await store.refreshProviders({ dispose: true });

  expect(composer.getCurrentResult().data?.connected).toEqual(["eigenwelt"]);
  unsubscribe();
});

test("an engine reload drops the cached lists of workspaces not on screen", async () => {
  // Cached while another workspace was open, before Eigenwelt was signed in:
  // kept, it would show that workspace's models as unavailable when reopened.
  const otherWorkspace = providerListQueryKey({ baseUrl: "http://127.0.0.1:4096", directory: "/tmp/other" });
  getReactQueryClient().setQueryData(otherWorkspace, providerList([]));

  await refreshProviderListQueries(getReactQueryClient());

  expect(getReactQueryClient().getQueryData(otherWorkspace)).toBeUndefined();
});
