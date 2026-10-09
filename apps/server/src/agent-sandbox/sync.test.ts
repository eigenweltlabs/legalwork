import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEigenweltEntitlements, eigenweltPlatformUrl } from "../eigenwelt-auth.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { closeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";
import { readSandboxDefault, writeSessionSandbox, effectiveSandbox } from "./settings.js";
import { saveSandboxDefault, syncSandboxSettings, sandboxSyncStatus } from "./sync.js";
import { sandboxSettingsSchema } from "./settings-schema.js";
import { z } from "zod";

test("application default sync handles devices, offline edits, conflicts, accounts and plans", async () => {
  const root = process.env.LEGALWORK_SANDBOX_SYNC_TEST_ROOT;
  if (!root) {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-sync-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.filename], { env: { ...process.env, LEGALWORK_SANDBOX_SYNC_TEST_ROOT: directory }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, output: code === 0 ? "passed" : stdout + stderr }).toEqual({ code: 0, output: "passed" });
    } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    return;
  }
  const config = (name: string): ServerConfig => ({ host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, name, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false });
  const a = config("a"), b = config("b");
  const signIn = async (config: ServerConfig, userId = "member", features = ["settings_presets"]) => {
    const entitlements = parseEigenweltEntitlements({ plan: "sync", subscriptionStatus: "active", features });
    if (!entitlements) throw new Error("Invalid test entitlements");
    await writeEigenweltConnection(config, { account: { userId, orgId: "firm", orgName: "Firm", userName: null, userEmail: null }, entitlements, platformURL: eigenweltPlatformUrl(), platformToken: `token-${userId}`, accessTokenExpiresAt: Date.now() + 3600000 });
  };
  const snapshots = new Map<string, { revision: number; sandbox: z.infer<typeof sandboxSettingsSchema> }>();
  let offline = false, writes = 0, calls = 0;
  const request: typeof fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (offline) throw new Error("Offline");
    const account = new Headers(init?.headers).get("Authorization") ?? "";
    const current = snapshots.get(account) ?? { revision: 0, sandbox: { enabled: false, networkMode: "approve" } };
    if (init?.method === "PUT") {
      writes++;
      const input = z.object({ revision: z.number(), sandbox: sandboxSettingsSchema }).parse(JSON.parse(String(init.body)));
      if (input.revision !== current.revision && JSON.stringify(input.sandbox) !== JSON.stringify(current.sandbox)) return new Response(null, { status: 409 });
      if (JSON.stringify(input.sandbox) !== JSON.stringify(current.sandbox)) snapshots.set(account, { revision: current.revision + 1, sandbox: input.sandbox });
    }
    return Response.json(snapshots.get(account) ?? current);
  }, { preconnect: fetch.preconnect });
  expect(await readSandboxDefault(a)).toEqual({ enabled: false, networkMode: "approve" });
  await signIn(a); await signIn(b);
  await syncSandboxSettings(a, request); await syncSandboxSettings(b, request);
  expect(writes).toBe(0);
  await saveSandboxDefault(a, { enabled: true, networkMode: "block" });
  await syncSandboxSettings(a, request); await syncSandboxSettings(b, request);
  expect(await readSandboxDefault(b)).toEqual({ enabled: true, networkMode: "block" });
  await writeSessionSandbox(b, "workspace", "chat", { enabled: false, networkMode: "allow" });
  offline = true;
  await saveSandboxDefault(a, { enabled: true, networkMode: "allow" });
  await syncSandboxSettings(a, request);
  expect(sandboxSyncStatus(a)).toBe("pending");
  expect(await readSandboxDefault(a)).toEqual({ enabled: true, networkMode: "allow" });
  offline = false;
  await syncSandboxSettings(a, request); await syncSandboxSettings(b, request);
  expect(await readSandboxDefault(b)).toEqual({ enabled: true, networkMode: "allow" });
  expect(await effectiveSandbox(b, "workspace", ["chat"])).toMatchObject({ enabled: false, source: "session" });
  // Both devices edit revision 2. Only the first upload succeeds.
  await saveSandboxDefault(a, { enabled: false, networkMode: "block" });
  await saveSandboxDefault(b, { enabled: true, networkMode: "approve" });
  await syncSandboxSettings(a, request); await syncSandboxSettings(b, request);
  expect(sandboxSyncStatus(b)).toBe("conflict");
  expect(await readSandboxDefault(b)).toEqual(await readSandboxDefault(a));
  // A slow network pull cannot block or overwrite a new local choice.
  let release: () => void = () => {}, entered: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const slow: typeof fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    entered(); await waiting; return request(url, init);
  }, { preconnect: fetch.preconnect });
  const round = syncSandboxSettings(a, slow);
  await started;
  await saveSandboxDefault(a, { enabled: true, networkMode: "approve" });
  release(); await round;
  expect(await readSandboxDefault(a)).toEqual({ enabled: true, networkMode: "approve" });
  expect(sandboxSyncStatus(a)).toBe("pending");
  await syncSandboxSettings(a, request);
  // An older upload may complete after the user makes another choice.
  await saveSandboxDefault(a, { enabled: false, networkMode: "allow" });
  const uploading = new Promise<void>(resolve => { entered = resolve; });
  const uploadGate = new Promise<void>(resolve => { release = resolve; });
  const slowUpload: typeof fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") { entered(); await uploadGate; }
    return request(url, init);
  }, { preconnect: fetch.preconnect });
  const upload = syncSandboxSettings(a, slowUpload);
  await uploading;
  await saveSandboxDefault(a, { enabled: true, networkMode: "block" });
  release(); await upload;
  await syncSandboxSettings(a, request);
  expect(sandboxSyncStatus(a)).toBe("synced");
  expect(await readSandboxDefault(a)).toEqual({ enabled: true, networkMode: "block" });
  expect(snapshots.get("Bearer token-member")?.sandbox).toEqual({ enabled: true, networkMode: "block" });
  // A queued old-account edit must never upload to a different account.
  await saveSandboxDefault(b, { enabled: true, networkMode: "allow" });
  const beforeSwitch = writes;
  await signIn(b, "different"); await syncSandboxSettings(b, request);
  expect(writes).toBe(beforeSwitch);
  expect(await readSandboxDefault(b)).toEqual({ enabled: false, networkMode: "approve" });
  await signIn(b, "different", []);
  const beforePlan = calls;
  await saveSandboxDefault(b, { enabled: true, networkMode: "block" });
  await syncSandboxSettings(b, request);
  expect(calls).toBe(beforePlan);
  expect(sandboxSyncStatus(b)).toBe("local");
  await closeRuntimeOpencodeConfig(b);
  expect(await readSandboxDefault(b)).toEqual({ enabled: true, networkMode: "block" });
}, 30000);
