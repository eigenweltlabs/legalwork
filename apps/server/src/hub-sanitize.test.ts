import { describe, expect, test } from "bun:test";
import { runtimeEngineConfiguration } from "./runtime-config-upgrade.js";

import {
  containsSecretKey,
  isSecretKey,
  sanitizeIntegrationMcp,
  sanitizePresetFragment,
  stripSecrets,
} from "./hub-sanitize.js";

describe("isSecretKey", () => {
  test("flags credential-shaped keys (any casing / separator)", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "api-key",
      "X-Api-Key",
      "OPENAI_API_KEY",
      "secret",
      "clientSecret",
      "client_secret",
      "token",
      "accessToken",
      "access-token",
      "password",
      "Authorization",
      "bearer",
      "credential",
      "privateKey",
      "private_key",
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  test("leaves structural keys alone", () => {
    for (const key of ["type", "url", "command", "headers", "env", "model", "name", "baseURL"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe("sanitizeIntegrationMcp", () => {
  test("native sharing keeps a paused connector and its explicit sign-in scope without sharing credentials", () => {
    const result = sanitizeIntegrationMcp({ type: "remote", url: "https://fixture.invalid/mcp", disabled: true, timeout: { execution: 75000 }, protocol: "auto", codemode: true,
      oauth: { client_id: "private-registration", client_secret: "synthetic-secret", scope: "documents:read" } });
    expect(result).toEqual({ type: "remote", url: "https://fixture.invalid/mcp", disabled: true, timeout: { execution: 75000 }, protocol: "auto", codemode: true, oauth: { scope: "documents:read" } });
    expect(() => runtimeEngineConfiguration({ mcp: { servers: { fixture: result } } })).not.toThrow();
    expect(JSON.stringify(result)).not.toContain("private-registration");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  test("drops top-level and nested secret keys", () => {
    const clean = sanitizeIntegrationMcp({
      type: "remote",
      url: "https://acme.example.com/mcp",
      apiKey: "sk-live-123",
      headers: {
        Authorization: "Bearer eyJhbGciOi...",
        "X-Api-Key": "abc123",
        "X-Tenant": "acme",
      },
      options: { token: "nested-secret", timeoutMs: 5000 },
    });

    expect(clean).toEqual({
      type: "remote",
      url: "https://acme.example.com/mcp",
    });
    expect(containsSecretKey(clean)).toBe(false);
  });

  test("blanks auth-scheme values hiding under innocuous header keys", () => {
    const clean = sanitizeIntegrationMcp({
      type: "remote",
      url: "https://x.dev/mcp",
      headers: { "X-Custom": "Bearer sneaky-token", "X-Region": "eu" },
    });
    expect(clean).toEqual({ type: "remote", url: "https://x.dev/mcp" });
  });

  test("strips secret-named env keys from a local server", () => {
    const clean = sanitizeIntegrationMcp({
      type: "local",
      command: ["node", "server.js"],
      env: { GITHUB_TOKEN: "ghp_xxx", MY_SECRET: "s", NODE_ENV: "production", PORT: "8080" },
    });
    expect(clean).toEqual({ type: "local", command: ["node", "server.js"] });
    expect(containsSecretKey(clean)).toBe(false);
  });

  test("removes credentials embedded in generic keys, URLs, and command arguments", () => {
    expect(sanitizeIntegrationMcp({
      type: "remote",
      url: "https://user:pass@example.com/mcp?api_key=secret&tenant=acme",
      key: "opaque-secret",
    })).toEqual({ type: "remote", url: "https://example.com/mcp?tenant=acme" });

    expect(sanitizeIntegrationMcp({
      type: "local",
      command: ["server", "--token", "secret", "--region", "eu", "sk-live-12345678"],
      key: "opaque-secret",
    })).toEqual({ type: "local", command: ["server", "--region", "eu"] });
  });
});

describe("sanitizePresetFragment", () => {
  test("native presets keep canonical choices and typed controls without private transport definitions", () => {
    const fixtureURL = new URL("https://example.invalid/v1");
    fixtureURL.username = "private"; fixtureURL.password = "secret";
    const clean = sanitizePresetFragment({ providers: { custom: {
      canonical: "openai", name: "Firm connection", package: "@opencode/ai/providers/openai-compatible", env: ["FIRM_KEY"],
      settings: { baseURL: fixtureURL.href, apiKey: "synthetic-secret" }, headers: { "X-Private": "synthetic-header" },
      models: { reasoning: { modelID: "exact-model", name: "Firm Model", limit: { context: 900_000, output: 80_000 },
        settings: { temperature: 0.2 }, body: { reasoningEffort: "high", private_transport: "synthetic-body" },
        variants: [{ id: "Careful", body: { reasoningEffort: "high" }, headers: { "X-Mode": "synthetic-variant" } }] } },
    } }, providerSetup: { custom: true, ignored: false }, model: "custom/reasoning", default_agent: "not-shared", $legalworkReadOnlyProjection: true });
    expect(clean).toMatchObject({ providerSetup: { custom: true }, model: "custom/reasoning", providers: { custom: {
      canonical: "openai", name: "Firm connection", package: "@opencode/ai/providers/openai-compatible",
      models: { reasoning: { modelID: "exact-model", limit: { context: 900_000, output: 80_000 }, body: { reasoningEffort: "high" }, variants: [{ id: "Careful", body: { reasoningEffort: "high" } }] } },
    } } });
    expect(JSON.stringify(clean)).not.toContain("synthetic-");
    expect(JSON.stringify(clean)).not.toContain("example.invalid");
    expect(clean).not.toHaveProperty("$legalworkReadOnlyProjection");
    expect(clean).not.toHaveProperty("default_agent");
    expect(() => runtimeEngineConfiguration({ providers: clean.providers, model: clean.model })).not.toThrow();
  });
  test("keeps only provider/model/small_model and strips provider secrets", () => {
    const clean = sanitizePresetFragment({
      model: "anthropic/claude-opus",
      small_model: "anthropic/claude-haiku",
      provider: {
        anthropic: {
          npm: "@ai-sdk/anthropic",
          name: "Anthropic",
          options: { baseURL: "https://api.anthropic.com", apiKey: "sk-ant-123" },
          models: { "claude-opus": { name: "Claude Opus" } },
        },
      },
      // Non-shareable keys must be dropped wholesale.
      keybinds: { leader: "ctrl+x" },
      mcp: { secretServer: { type: "local", command: ["x"] } },
    });

    expect(clean).toEqual({
      model: "anthropic/claude-opus",
      small_model: "anthropic/claude-haiku",
      provider: {
        anthropic: {
          npm: "@ai-sdk/anthropic",
          name: "Anthropic",
          options: { baseURL: "https://api.anthropic.com" },
          models: { "claude-opus": { name: "Claude Opus" } },
        },
      },
    });
    expect(containsSecretKey(clean)).toBe(false);
  });

  test("returns an empty fragment when nothing safe is present", () => {
    expect(sanitizePresetFragment({ apiKey: "x", theme: "dark" })).toEqual({});
  });
});

describe("stripSecrets", () => {
  test("is deep and array-aware", () => {
    const clean = stripSecrets({
      list: [{ token: "a", keep: 1 }, { keep: 2 }],
      nested: { deep: { password: "p", ok: true } },
    });
    expect(clean).toEqual({ list: [{ keep: 1 }, { keep: 2 }], nested: { deep: { ok: true } } });
  });
});
