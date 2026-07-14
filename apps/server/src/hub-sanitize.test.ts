import { describe, expect, test } from "bun:test";

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
      headers: { "X-Tenant": "acme" },
      options: { timeoutMs: 5000 },
    });
    expect(containsSecretKey(clean)).toBe(false);
  });

  test("blanks auth-scheme values hiding under innocuous header keys", () => {
    const clean = sanitizeIntegrationMcp({
      type: "remote",
      url: "https://x.dev/mcp",
      headers: { "X-Custom": "Bearer sneaky-token", "X-Region": "eu" },
    }) as { headers: Record<string, string> };
    expect(clean.headers["X-Custom"]).toBe("");
    expect(clean.headers["X-Region"]).toBe("eu");
  });

  test("strips secret-named env keys from a local server", () => {
    const clean = sanitizeIntegrationMcp({
      type: "local",
      command: ["node", "server.js"],
      env: { GITHUB_TOKEN: "ghp_xxx", MY_SECRET: "s", NODE_ENV: "production", PORT: "8080" },
    }) as { env: Record<string, string> };
    expect(clean.env).toEqual({ NODE_ENV: "production", PORT: "8080" });
    expect(containsSecretKey(clean)).toBe(false);
  });
});

describe("sanitizePresetFragment", () => {
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
