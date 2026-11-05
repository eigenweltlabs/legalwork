import { expect, test } from "bun:test";
import { presetConfiguration } from "../src/app/native-preset";
import { buildPresetFragment } from "../src/react-app/domains/settings/pages/share-preset-section";

test("sharing native model choices excludes the read-only envelope and records endpoint setup", () => {
  const providers = { firm: { canonical: "openai", models: { precise: { modelID: "exact", limit: { context: 900_000 }, variants: [{ id: "Careful", body: { reasoningEffort: "high" } }] } } }, builtin: { canonical: "anthropic" } };
  expect(buildPresetFragment({ providers, model: "firm/precise", permissions: [{ action: "*", effect: "allow" }], $legalworkReadOnlyProjection: true }, { firm: { hasCustomEndpoint: true }, builtin: { hasCustomEndpoint: false } })).toEqual({
    providers, model: "firm/precise", providerSetup: { firm: true },
  });
});

test("a new custom connection remains unavailable until setup; existing connections and canonical builtins remain usable", () => {
  const payload = { providers: {
    firm: { canonical: "openai", models: { precise: { modelID: "exact", limit: { context: 900_000 }, variants: [{ id: "Careful", body: { reasoningEffort: "high" } }] } } },
    saved: { models: { precise: { modelID: "saved-model" } } }, builtin: { canonical: "anthropic", models: { canonical: {} } },
  }, model: "firm/precise", providerSetup: { firm: true, saved: true }, permissions: [{ action: "*", effect: "allow" }], mcp: { unrequested: {} } };
  const result = presetConfiguration(payload, { saved: { hasCustomEndpoint: true } });
  expect(result.requiresSetup).toEqual(["firm"]);
  expect(result.configuration).toEqual({ providers: {
    firm: { ...payload.providers.firm, models: { precise: { ...payload.providers.firm.models.precise, disabled: true } } },
    saved: payload.providers.saved, builtin: payload.providers.builtin,
  }, model: "firm/precise" });
  expect(payload.providers.firm.models.precise).not.toHaveProperty("disabled");
  expect(result.configuration).not.toHaveProperty("providerSetup");
  expect(result.configuration).not.toHaveProperty("mcp");
});

test("read-only connection responses cannot be applied as executable presets", () => {
  expect(() => presetConfiguration({ providers: {}, $legalworkReadOnlyProjection: true })).toThrow("read-only");
});
