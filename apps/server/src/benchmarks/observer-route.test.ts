import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server.js";
import { benchmarkModelTransportFingerprint } from "./model-transport.js";
import type { ServerConfig } from "../types.js";

test("observer relay requires host authority and fixes native plugin, method and workspace without truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "benchmark-observer-route-"));
  const directory = join(root, "matter"); await mkdir(directory);
  const calls: { path: string; location: unknown; body?: unknown }[] = [];
  const output = { observer: { id: "legalwork-benchmark-observer", mutatesEngine: false }, schemaCoverage: "complete", tools: [{ id: "fixture", description: "Complete schema ".repeat(20_000), input: { $defs: { Nested: { type: "string" } }, $ref: "#/$defs/Nested" } }] };
  const modelID = "Fixture Gemini / EU";
  const privateBaseURL = "http://127.0.0.1:54321/v1", privateApiKey = "fixture-local-key-never-returned";
  const engine = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/model" || url.pathname.startsWith("/api/rpc/")) {
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("observer:fixture-private").toString("base64")}`);
      calls.push({ path: url.pathname, location: url.searchParams.get("location[directory]"), ...(request.method === "POST" ? { body: await request.json() } : {}) });
    }
    if (url.pathname === "/api/model") return Response.json({ location: { directory }, data: [{ id: modelID, providerID: "benchmark", settings: { baseURL: privateBaseURL, apiKey: privateApiKey } }, { id: "other-only", providerID: "other", settings: { baseURL: "https://other.invalid", apiKey: "other-private-key" } }] });
    if (url.pathname === "/api/rpc/legalwork-benchmark-observer/catalog") return Response.json({ output });
    return Response.json({ data: [] });
  } });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "observer-client", hostToken: "observer-host", configPath: join(root, "private", "server.json"),
    opencodeBaseUrl: engine.url.origin, opencodeUsername: "observer", opencodePassword: "fixture-private", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "matter", name: "Matter", path: directory, preset: "starter", workspaceType: "local" }], authorizedRoots: [directory], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const server = await startServer(config), base = `http://127.0.0.1:${server.port}`;
  const path = "/workspace/matter/benchmarks/observer/catalog";
  try {
    expect((await fetch(base + path)).status).toBe(401);
    expect((await fetch(base + path, { headers: { authorization: "Bearer observer-client" } })).status).toBe(401);
    const viewer = "owt_retired_viewer";
    expect((await fetch(base + path, { headers: { authorization: `Bearer ${viewer}` } })).status).toBe(401);
    expect(calls).toEqual([]);
    config.engineProjectTrustRequired = true;
    expect((await fetch(base + path, { headers: { "x-legalwork-host-token": "observer-host" } })).status).toBe(409);
    expect(calls).toEqual([]);
    config.engineProjectTrustRequired = false;
    const allowed = await fetch(base + path + "?plugin=other&method=execute&location[directory]=/unrelated", { headers: { "x-legalwork-host-token": "observer-host" } });
    expect(allowed.status).toBe(200); expect(await allowed.json()).toEqual(output);
    expect(calls).toEqual([{ path: "/api/model", location: directory }, { path: "/api/rpc/legalwork-benchmark-observer/catalog", location: directory, body: { input: {} } }]);
    expect((await fetch(base + "/workspace/unknown/benchmarks/observer/catalog", { headers: { "x-legalwork-host-token": "observer-host" } })).status).toBe(404);
    const blocked = await fetch(base + "/workspace/matter/opencode/api/rpc/legalwork-benchmark-observer/catalog", { method: "POST", headers: { "x-legalwork-host-token": "observer-host", "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
    expect(blocked.status).toBe(403); expect(calls).toHaveLength(2);
    const transportPath = "/workspace/matter/benchmarks/observer/model-transport";
    const selection = `?${new URLSearchParams({ modelID })}`;
    expect((await fetch(base + transportPath + selection, { headers: { authorization: "Bearer observer-client" } })).status).toBe(401);
    expect((await fetch(base + transportPath + selection, { headers: { authorization: `Bearer ${viewer}` } })).status).toBe(401);
    expect(calls).toHaveLength(2);
    config.engineProjectTrustRequired = true;
    expect((await fetch(base + transportPath + selection, { headers: { "x-legalwork-host-token": "observer-host" } })).status).toBe(409);
    expect(calls).toHaveLength(2);
    config.engineProjectTrustRequired = false;
    expect((await fetch(base + transportPath, { headers: { "x-legalwork-host-token": "observer-host" } })).status).toBe(400);
    expect((await fetch(base + transportPath + "?modelID=other-only&providerID=other", { headers: { "x-legalwork-host-token": "observer-host" } })).status).toBe(404);
    const attested = await fetch(base + transportPath + selection + "&providerID=other&baseURL=https://attacker.invalid&location[directory]=/unrelated", { headers: { "x-legalwork-host-token": "observer-host" } });
    expect(attested.status).toBe(200);
    const rawAttestation = await attested.text();
    expect(rawAttestation).not.toContain(privateBaseURL); expect(rawAttestation).not.toContain(privateApiKey); expect(rawAttestation).not.toContain("other-private-key");
    expect(JSON.parse(rawAttestation)).toEqual({ kind: "benchmark-model-transport-attestation", providerID: "benchmark", modelID, algorithm: "sha256", fingerprint: benchmarkModelTransportFingerprint(privateBaseURL, privateApiKey) });
    expect(calls.slice(2)).toEqual([{ path: "/api/model", location: directory }, { path: "/api/model", location: directory }]);
    expect(benchmarkModelTransportFingerprint(privateBaseURL, privateApiKey)).not.toBe(benchmarkModelTransportFingerprint(privateBaseURL, "different-key"));
    expect(benchmarkModelTransportFingerprint(privateBaseURL, privateApiKey)).not.toBe(benchmarkModelTransportFingerprint("https://different.invalid", privateApiKey));
  } finally { await server.stop(); engine.stop(true); await rm(root, { recursive: true, force: true }); }
});
