import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";

test("OCR HTTP settings require host authority, redact keys and respect read-only mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-routes-"));
  const previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "token", hostToken: "host-token", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [],
    workspaces: [{ id: "ws_1", name: "Test", path: workspace, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspace], readOnly: false, startedAt: Date.now(),
    tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" };
    expect((await fetch(`${base}/ocr/settings`)).status).toBe(401);
    expect((await fetch(`${base}/ocr/servers`, { method: "POST", body: "{}" })).status).toBe(401);
    const saved = await fetch(`${base}/ocr/servers`, { headers, method: "POST", body: JSON.stringify({ label: "Server", model: "vision", endpoint: "https://example.com/chat/completions", apiKey: "super-secret", languages: null }) });
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).toContain('"keyConfigured":true');
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("apiKeyRef");
    const unavailable = await fetch(`${base}/ocr/default`, { headers, method: "PUT", body: JSON.stringify({ engineId: "local-fast" }) });
    expect(unavailable.status).toBe(400);
    expect(await unavailable.text()).toContain("ocr_not_ready");
    config.readOnly = true;
    for (const [path, method, body] of [
      ["/ocr/default", "PUT", '{"engineId":"local-quality"}'],
      ["/ocr/servers", "POST", "{}"],
      ["/ocr/engines/local-fast/install", "POST", "{}"],
      ["/ocr/engines/local-fast/test", "POST", "{}"],
      ["/ocr/install", "DELETE", "{}"],
    ]) expect((await fetch(`${base}${path}`, { headers, method, body })).status).toBe(403);
    expect((await fetch(`${base}/ocr/settings`, { headers })).status).toBe(200);
  } finally {
    await server.stop();
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
    else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
