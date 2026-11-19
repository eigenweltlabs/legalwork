import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService } from "../approvals.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { parseEigenweltEntitlements } from "../eigenwelt-auth.js";
import { writeCachedEigenweltPaidManifest } from "../eigenwelt-paid-manifest.js";
import { ReloadEventStore } from "../events.js";
import { bootstrapRuntimeOpencodeConfig, closeRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { TokenService } from "../tokens.js";
import type { ServerConfig } from "../types.js";
import { matchRoute, type RequestContext, type Route } from "./registry.js";
import { registerNativeCommandDefinitionRoutes } from "./native-command-definitions.js";

test("command discovery preserves local overrides without checking cloud model availability on each refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-command-refresh-"));
  const previousPlatform = process.env.EIGENWELT_PLATFORM_URL;
  let platformReads = 0, engineReads = 0, scopeChecks = 0;
  const platform = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    platformReads++;
    return Response.json({ baseURL: "http://127.0.0.1:1", model: "EigenJev", region: "EU", enabled: true, available: true, questionTypes: ["noul", "choice", "score"] });
  } });
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api/config");
    engineReads++;
    return Response.json([{ type: "document", info: { commands: { authored: { template: "Authored template" }, same: { template: "Authored default" } } } }]);
  } });
  const config: ServerConfig = { configPath: join(root, "server.json"), host: "127.0.0.1", port: 0, token: "synthetic-client", hostToken: "synthetic-host",
    workspaces: [{ id: "project", path: root, name: "Synthetic project", preset: "starter", workspaceType: "local" }], authorizedRoots: [root],
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: Date.now(),
    tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false, opencodeBaseUrl: engine.url.origin };
  try {
    process.env.EIGENWELT_PLATFORM_URL = platform.url.origin;
    await bootstrapRuntimeOpencodeConfig(config);
    await writeRuntimeOpencodeConfig(config, "project", current => ({ ...current, commands: { same: { template: "App override" } } }));
    await writeEigenweltConnection(config, { platformURL: platform.url.origin, platformToken: "synthetic-platform-token",
      entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active", features: ["premium_models"] }) });
    await writeCachedEigenweltPaidManifest(config, { baseURL: platform.url.origin + "/v1", apiKey: "synthetic-model-key", models: [] });
    const routes: Route[] = [];
    registerNativeCommandDefinitionRoutes({ routes, config, jsonResponse: data => Response.json(data),
      requireClientScope: (_ctx, required) => { expect(required).toBe("collaborator"); scopeChecks++; },
      resolveWorkspace: async () => config.workspaces[0]! });
    const route = matchRoute(routes, "GET", "/workspace/project/commands/definitions");
    if (!route) throw new Error("Command discovery route missing");
    const context: RequestContext = { config, request: new Request("http://localhost/workspace/project/commands/definitions"),
      url: new URL("http://localhost/workspace/project/commands/definitions"), params: route.params,
      approvals: new ApprovalService(config.approval), reloadEvents: new ReloadEventStore(), tokens: new TokenService(config) };
    expect(route.auth).toBe("client");
    for (let i = 0; i < 20; i++) {
      const response = await route.handler(context);
      expect(response.status).toBe(200);
      expect((await response.json()).commands).toMatchObject({ authored: { template: "Authored template" }, same: { template: "App override" } });
    }
    expect(engineReads).toBe(20);
    expect(scopeChecks).toBe(20);
    expect(platformReads).toBe(0);
    await writeRuntimeOpencodeConfig(config, "project", current => ({ ...current, commands: { same: { template: "Updated local override" } } }));
    expect((await (await route.handler(context)).json()).commands.same.template).toBe("Updated local override");
    expect(platformReads).toBe(0);
  } finally {
    if (previousPlatform === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
    else process.env.EIGENWELT_PLATFORM_URL = previousPlatform;
    await closeRuntimeOpencodeConfig(config);
    platform.stop(true); engine.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
