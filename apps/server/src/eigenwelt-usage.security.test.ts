import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import { TokenService } from "./tokens.js";
import type { ServerConfig } from "./types.js";

test("billing routes reject collaborators, viewers and unauthenticated clients before using the owner's identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-billing-security-"));
  const previousStore = process.env.LEGALWORK_TOKEN_STORE;
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "disposable-collaborator-token", hostToken: "disposable-host-token",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [{ id: "ws_test", name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const tokens = new TokenService(config);
  const viewer = await tokens.create("viewer");
  const owner = await tokens.create("owner");
  const server = await startServer(config);
  try {
    const url = `http://127.0.0.1:${server.port}/workspace/ws_test/eigenwelt/usage`;
    for (const method of ["GET", "POST"]) {
      for (const token of [undefined, "invalid", config.token, viewer.token]) {
        const response = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(method === "POST" ? { body: JSON.stringify({ action: "topUp", amountCents: 5000 }) } : {}),
        });
        expect(response.status).toBe(token === config.token || token === viewer.token ? 403 : 401);
      }
      // The owner passes local authorization, then needs an actual platform
      // sign-in. No remote identity or payment service is contacted here.
      const response = await fetch(url, {
        method, headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ action: "paymentDetails" }) } : {}),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "sign_in_required" });
    }
  } finally {
    await server.stop();
    if (previousStore === undefined) delete process.env.LEGALWORK_TOKEN_STORE;
    else process.env.LEGALWORK_TOKEN_STORE = previousStore;
    await rm(root, { recursive: true, force: true });
  }
});
