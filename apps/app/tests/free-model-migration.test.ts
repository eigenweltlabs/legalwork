import { describe, expect, test } from "bun:test";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import {
  EIGENWELT_FREE_PROVIDER_ID,
  isFreeOpencodeModel,
  remapZenSelectionToEigenweltFree,
} from "../src/react-app/infra/provider-list-query";

/**
 * Free-tier migration for existing installs: persisted selections on the
 * engine's built-in OpenCode Zen provider ("opencode") strand when the
 * server injects eigenwelt-free and disables zen. remapZenSelectionToEigenweltFree
 * is the pure decision function behind the auto-switch in session-route.tsx.
 */

const ZEN_MODEL = { providerID: "opencode", modelID: "big-pickle" };

function providerList(input: {
  zenConnected?: boolean;
  freeConnected?: boolean;
  freeModels?: Record<string, unknown>;
}): ProviderListResponse {
  const all: unknown[] = [];
  const connected: string[] = [];
  if (input.zenConnected) {
    all.push({
      id: "opencode",
      name: "OpenCode Zen",
      source: "custom",
      models: { "big-pickle": { cost: { input: 0, output: 0 } } },
    });
    connected.push("opencode");
  }
  if (input.freeConnected) {
    all.push({
      id: EIGENWELT_FREE_PROVIDER_ID,
      name: "Eigenwelt Free",
      source: "config",
      models: input.freeModels ?? { "ewl-free-small": {}, "ewl-free-base": {} },
    });
    connected.push(EIGENWELT_FREE_PROVIDER_ID);
  }
  return { all, connected, default: {} } as ProviderListResponse;
}

describe("remapZenSelectionToEigenweltFree", () => {
  test("remaps a stranded zen selection to the free provider's first model", () => {
    const value = providerList({ zenConnected: false, freeConnected: true });
    expect(remapZenSelectionToEigenweltFree(value, ZEN_MODEL)).toEqual({
      providerID: EIGENWELT_FREE_PROVIDER_ID,
      modelID: "ewl-free-small",
    });
  });

  test("does nothing before the provider list has loaded", () => {
    expect(remapZenSelectionToEigenweltFree(null, ZEN_MODEL)).toBeNull();
    expect(remapZenSelectionToEigenweltFree(undefined, ZEN_MODEL)).toBeNull();
  });

  test("does nothing while zen still serves the selected model", () => {
    const value = providerList({ zenConnected: true, freeConnected: true });
    expect(remapZenSelectionToEigenweltFree(value, ZEN_MODEL)).toBeNull();
  });

  test("does nothing when eigenwelt-free is not connected (zen down for other reasons)", () => {
    const value = providerList({ zenConnected: false, freeConnected: false });
    expect(remapZenSelectionToEigenweltFree(value, ZEN_MODEL)).toBeNull();
  });

  test("does nothing when eigenwelt-free has no models", () => {
    const value = providerList({ zenConnected: false, freeConnected: true, freeModels: {} });
    expect(remapZenSelectionToEigenweltFree(value, ZEN_MODEL)).toBeNull();
  });

  test("never touches selections on other providers", () => {
    const value = providerList({ zenConnected: false, freeConnected: true });
    expect(
      remapZenSelectionToEigenweltFree(value, { providerID: "anthropic", modelID: "gone-model" }),
    ).toBeNull();
    expect(remapZenSelectionToEigenweltFree(value, null)).toBeNull();
  });

  test("is idempotent: the remapped selection itself never remaps again", () => {
    const value = providerList({ zenConnected: false, freeConnected: true });
    const replacement = remapZenSelectionToEigenweltFree(value, ZEN_MODEL);
    expect(replacement).not.toBeNull();
    expect(remapZenSelectionToEigenweltFree(value, replacement)).toBeNull();
  });
});

describe("isFreeOpencodeModel with the eigenwelt-free provider", () => {
  test("every eigenwelt-free model counts as free (warning banner shows)", () => {
    const value = providerList({ freeConnected: true });
    expect(
      isFreeOpencodeModel(value, { providerID: EIGENWELT_FREE_PROVIDER_ID, modelID: "ewl-free-small" }),
    ).toBe(true);
  });

  test("zero-cost zen models still count as free", () => {
    const value = providerList({ zenConnected: true });
    expect(isFreeOpencodeModel(value, ZEN_MODEL)).toBe(true);
  });

  test("other providers' models are not free-tier", () => {
    const value = providerList({ freeConnected: true });
    expect(isFreeOpencodeModel(value, { providerID: "anthropic", modelID: "claude" })).toBe(false);
  });
});
