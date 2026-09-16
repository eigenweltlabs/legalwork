import { describe, expect, test } from "bun:test";

import {
  aiAccessState,
  forgetEigenweltAccount,
  isAiPlansVariant,
  readRememberedEigenweltAccount,
  rememberEigenweltAccount,
  type AiAccessInput,
} from "../src/app/lib/eigenwelt-access";
import { EIGENWELT_PLANS, formatEuroCents, isEigenweltPlanId } from "../src/app/lib/eigenwelt-plans";

/**
 * The plan screen lies over the app whenever no model is usable. These cases
 * pin which variant a user sees, and that a working app never gets the
 * screen (or gets it only once the inputs have loaded).
 */

const withModels = (id: string) => ({ id, models: { [`${id}-model`]: {} } });
const withoutModels = (id: string) => ({ id, models: {} });

const entitled = (features: string[] = ["premium_models"], status = "active") => ({
  connected: true,
  entitlements: { subscriptionStatus: status, features },
});

const state = (input: Partial<AiAccessInput>) =>
  aiAccessState({
    connectedProviders: [],
    eigenwelt: { connected: false, entitlements: null },
    signedInBefore: false,
    ...input,
  });

describe("aiAccessState", () => {
  test("nothing is decided while the provider list loads", () => {
    expect(state({ connectedProviders: null })).toBe("unknown");
    expect(state({ connectedProviders: null, eigenwelt: entitled() })).toBe("unknown");
  });

  test("an own provider with models makes the app ready, whatever the account says", () => {
    expect(state({ connectedProviders: [withModels("anthropic")] })).toBe("ready");
    expect(state({ connectedProviders: [withModels("openai")], eigenwelt: undefined })).toBe("ready");
    expect(
      state({
        connectedProviders: [withModels("ollama")],
        eigenwelt: entitled([], "canceled"),
      }),
    ).toBe("ready");
  });

  test("own providers without models, and the retired free tiers, do not count", () => {
    expect(state({ connectedProviders: [withoutModels("ollama")] })).toBe("new");
    expect(state({ connectedProviders: [withModels("opencode")] })).toBe("new");
    expect(state({ connectedProviders: [withModels("eigenwelt-free")] })).toBe("new");
  });

  test("never signed in: the plans", () => {
    expect(state({})).toBe("new");
    expect(state({ eigenwelt: null })).toBe("new");
  });

  test("signed in before, signed out now: sign-in first", () => {
    expect(state({ signedInBefore: true })).toBe("signed-out");
    expect(state({ signedInBefore: true, eigenwelt: null })).toBe("signed-out");
  });

  test("the account view still loading: unknown, unless the engine serves Eigenwelt models", () => {
    expect(state({ eigenwelt: undefined })).toBe("unknown");
    expect(state({ eigenwelt: undefined, connectedProviders: [withModels("eigenwelt")] })).toBe("ready");
  });

  test("a subscribed firm with the models is ready", () => {
    expect(state({ eigenwelt: entitled() })).toBe("ready");
    expect(state({ eigenwelt: entitled(["premium_models"], "trialing") })).toBe("ready");
    expect(state({ eigenwelt: entitled(["premium_models"], "past_due") })).toBe("ready");
  });

  test("a subscription that no longer grants anything: restart a plan", () => {
    expect(state({ eigenwelt: entitled(["premium_models"], "canceled") })).toBe("ended");
    expect(state({ eigenwelt: entitled([], "unpaid") })).toBe("ended");
    expect(state({ eigenwelt: { connected: true, entitlements: { subscriptionStatus: null } } })).toBe(
      "ended",
    );
  });

  test("an ended subscription wins over Eigenwelt models the engine still lists", () => {
    expect(
      state({
        connectedProviders: [withModels("eigenwelt")],
        eigenwelt: entitled(["premium_models"], "canceled"),
      }),
    ).toBe("ended");
  });

  test("a plan without the models: upgrade", () => {
    expect(state({ eigenwelt: entitled(["admin_hub"]) })).toBe("no-models");
  });

  test("signed in without entitlements on record: the engine's models decide", () => {
    const legacy = { connected: true, entitlements: null };
    expect(state({ eigenwelt: legacy, connectedProviders: [withModels("eigenwelt")] })).toBe("ready");
    expect(state({ eigenwelt: legacy })).toBe("signed-out");
  });

  test("not signed in, but the engine still serves Eigenwelt models: ready", () => {
    expect(state({ connectedProviders: [withModels("eigenwelt")] })).toBe("ready");
    expect(state({ connectedProviders: [withoutModels("eigenwelt")] })).toBe("new");
  });

  test("only the plan-screen states are variants", () => {
    expect(isAiPlansVariant("ready")).toBe(false);
    expect(isAiPlansVariant("unknown")).toBe(false);
    for (const variant of ["new", "signed-out", "ended", "no-models"] as const) {
      expect(isAiPlansVariant(variant)).toBe(true);
    }
  });
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("the remembered account", () => {
  test("round-trips email and firm, and forgets on request", () => {
    const storage = memoryStorage();
    expect(readRememberedEigenweltAccount(storage)).toBeNull();
    rememberEigenweltAccount({ email: " anna@kanzlei.de ", firmName: "Kanzlei Berg" }, storage);
    expect(readRememberedEigenweltAccount(storage)).toEqual({
      email: "anna@kanzlei.de",
      firmName: "Kanzlei Berg",
    });
    forgetEigenweltAccount(storage);
    expect(readRememberedEigenweltAccount(storage)).toBeNull();
  });

  test("an account without details still counts as signed in before", () => {
    const storage = memoryStorage();
    rememberEigenweltAccount({ email: null, firmName: "" }, storage);
    expect(readRememberedEigenweltAccount(storage)).toEqual({ email: null, firmName: null });
  });

  test("garbage in storage reads as no account", () => {
    const storage = memoryStorage();
    storage.setItem("legalwork.eigenwelt.lastAccount", "{not json");
    expect(readRememberedEigenweltAccount(storage)).toBeNull();
    storage.setItem("legalwork.eigenwelt.lastAccount", "[1,2]");
    expect(readRememberedEigenweltAccount(storage)).toBeNull();
  });

  test("no storage at all is harmless", () => {
    expect(readRememberedEigenweltAccount(null)).toBeNull();
    expect(() => rememberEigenweltAccount({ email: "a@b.c", firmName: null }, null)).not.toThrow();
    expect(() => forgetEigenweltAccount(null)).not.toThrow();
  });
});

describe("the plan catalog", () => {
  test("mirrors the platform's prices and included usage", () => {
    expect(EIGENWELT_PLANS.map((plan) => [plan.id, plan.yearlyPerMonthCents, plan.monthlyCents, plan.includedMonthlyUsageCents])).toEqual([
      ["plus", 2900, 3900, 3000],
      ["pro", 6900, 8900, 7000],
    ]);
    expect(isEigenweltPlanId("plus")).toBe(true);
    expect(isEigenweltPlanId("hub")).toBe(false);
  });

  test("prices read naturally in both languages", () => {
    // Intl separates amount and sign with a no-break space in German.
    expect(formatEuroCents(2900, "en")).toBe("€29");
    expect(formatEuroCents(2900, "de").replace(/\s/g, " ")).toBe("29 €");
    expect(formatEuroCents(2950, "en")).toBe("€29.50");
  });
});
