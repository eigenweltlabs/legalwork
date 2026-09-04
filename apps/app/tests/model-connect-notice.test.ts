import { describe, expect, test } from "bun:test";

import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import {
  countConnectedProviders,
  isModelAvailableInConnectedProviders,
} from "../src/react-app/infra/provider-list-query";

/**
 * EIG-101: signing out of Eigenwelt flashed the composer's red "model no
 * longer available" label before the connect-AI bar (trial / log in / bring
 * your own) replaced it.
 *
 * The label is hidden in favour of the bar only when the selected model is
 * unavailable AND nothing is connected. Those two answers used to come from
 * different reads — the provider-list query decided the first, a separately
 * refreshed copy of the connected ids decided the second — so for the renders
 * in between, the query had already dropped `eigenwelt` while the copy still
 * listed it: unavailable, but "1 connected", which is exactly the label. Both
 * are now counted from one list, so there is no render where they disagree.
 */

const EIGENWELT_MODEL = { providerID: "eigenwelt", modelID: "ewl-1" };

const providerList = (input: {
  connected: string[];
  models?: Record<string, string[]>;
}): ProviderListResponse => ({
  all: Object.entries(input.models ?? { eigenwelt: ["ewl-1"] }).map(([id, modelIds]) => ({
    id,
    name: id,
    env: [],
    api: undefined,
    npm: undefined,
    source: "api" as const,
    models: Object.fromEntries(
      modelIds.map((modelId) => [modelId, { id: modelId, name: modelId }]),
    ),
  })),
  connected: input.connected,
  default: {},
}) as unknown as ProviderListResponse;

const signedIn = providerList({ connected: ["eigenwelt"] });
const signedOut = providerList({ connected: [] });

describe("connect-AI notice vs. the model-unavailable label", () => {
  test("signed in: the model resolves and the provider counts", () => {
    expect(isModelAvailableInConnectedProviders(signedIn, EIGENWELT_MODEL)).toBe(true);
    expect(countConnectedProviders(signedIn)).toBe(1);
  });

  test("signed out: the model is gone AND the count is 0 in the same read", () => {
    // The regression: these two came from different reads, so the label showed
    // while the count still said 1. One list can only ever answer both ways.
    expect(isModelAvailableInConnectedProviders(signedOut, EIGENWELT_MODEL)).toBe(false);
    expect(countConnectedProviders(signedOut)).toBe(0);
  });

  test("a stale selection with another provider still connected keeps the label", () => {
    // Not locked out — there is somewhere to switch to, so the bar stays away
    // and the label is the right thing to show.
    const withOther = providerList({
      connected: ["anthropic"],
      models: { anthropic: ["claude"] },
    });
    expect(isModelAvailableInConnectedProviders(withOther, EIGENWELT_MODEL)).toBe(false);
    expect(countConnectedProviders(withOther)).toBe(1);
  });

  test("a disabled provider is not something to switch to", () => {
    const withOther = providerList({
      connected: ["anthropic"],
      models: { anthropic: ["claude"] },
    });
    expect(countConnectedProviders(withOther, ["anthropic"])).toBe(0);
  });

  test("no list yet counts nothing", () => {
    expect(countConnectedProviders(null)).toBe(0);
    expect(countConnectedProviders(undefined)).toBe(0);
  });
});
