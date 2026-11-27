import { describe, expect, spyOn, test } from "bun:test";
import { TokenService } from "./tokens.js";
import type { ServerConfig } from "./types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { hashToken } from "./utils.js";

function createTestConfig(): ServerConfig {
  const tempDir = join(
    tmpdir(),
    `legalwork-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "test-client-token",
    hostToken: "test-host-token",
    configPath: join(tempDir, "server.json"),
    approval: { mode: "auto", timeoutMs: 30000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("application tokens", () => {
  test("accepts the configured application token only", async () => {
    const service = new TokenService(createTestConfig());
    expect(await service.scopeForToken("test-client-token")).toBe("collaborator");
    expect(await service.scopeForToken("test-host-token")).toBeNull();
    expect(await service.scopeForToken("unknown-token")).toBeNull();
    expect(await service.scopeForToken("")).toBeNull();
  });

  test("ignores persisted sharing credentials for every former role", async () => {
    const config = createTestConfig();
    const directory = dirname(config.configPath!);
    await mkdir(directory, { recursive: true });
    const credentials = ["owner", "collaborator", "viewer"].map((scope) => ({
      id: scope, hash: hashToken(`owt_legacy_${scope}`), scope, createdAt: Date.now(),
    }));
    try {
      await writeFile(join(directory, "tokens.json"), JSON.stringify({ schemaVersion: 1, tokens: credentials }));
      const service = new TokenService(config);
      for (const credential of credentials) {
        expect(await service.scopeForToken(`owt_legacy_${credential.id}`)).toBeNull();
      }
      expect(await service.scopeForToken(config.token)).toBe("collaborator");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("Raycast handoffs expire and become invalid when the credential rotates", () => {
  const tokens = new TokenService(createTestConfig());
  const token = tokens.rotateRaycast(true);
  const request = new Request("http://localhost/launcher/raycast/handoff", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const invocation = { id: "fixture", source: "raycast", action: "ask", query: "Synthetic question" } satisfies Parameters<TokenService["stageRaycast"]>[1];
  const now = spyOn(Date, "now").mockReturnValue(1000);
  try {
    const expired = tokens.stageRaycast(request, invocation);
    if (!expired) throw new Error("Expected a staged handoff");
    now.mockReturnValue(61_000);
    expect(tokens.consumeRaycast(expired)).toBeNull();
    const pending = tokens.stageRaycast(request, invocation);
    if (!pending) throw new Error("Expected a staged handoff");
    expect(tokens.rotateRaycast(true)).not.toBe(token);
    expect(tokens.consumeRaycast(pending)).toBeNull();
    expect(tokens.stageRaycast(request, invocation)).toBeNull();
  } finally { now.mockRestore(); }
});
