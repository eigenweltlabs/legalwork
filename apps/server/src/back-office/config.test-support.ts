import { join } from "node:path";
import type { ServerConfig } from "../types.js";

export function backOfficeTestConfig(root: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    configPath: join(root, "server.json"),
    host: "127.0.0.1",
    port: 0,
    token: "fixture",
    hostToken: "host",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    ...overrides,
  };
}
