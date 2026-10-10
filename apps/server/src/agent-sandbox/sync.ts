import { z } from "zod";
import { readEigenweltConnection, type EigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";
import { sandboxSettingsSchema, type SandboxSettings } from "./settings-schema.js";
import { SANDBOX_DEFAULT_ID, notifySandboxSettingsChange, onSandboxSettingsChange, withSandboxSettingsLock, writeSandboxDefault } from "./settings.js";

export type SandboxSyncStatus = "local" | "syncing" | "synced" | "pending" | "conflict";
const rounds = new WeakMap<ServerConfig, Promise<void>>();
const statuses = new WeakMap<ServerConfig, SandboxSyncStatus>();
export const sandboxSyncStatus = (config: ServerConfig) => statuses.get(config) ?? "local";
export function sandboxAccount(connection: EigenweltConnection): string | null {
  if (!connection.account || !connection.platformURL || !connection.entitlements?.features.includes("settings_presets")) return null;
  return JSON.stringify([connection.platformURL, connection.account.orgId, connection.account.userId]);
}
export async function saveSandboxDefault(config: ServerConfig, settings: SandboxSettings): Promise<void> {
  statuses.set(config, "pending");
  await writeSandboxDefault(config, settings, sandboxAccount(await readEigenweltConnection(config)));
}
const snapshotSchema = z.object({ revision: z.number().int().nonnegative(), sandbox: sandboxSettingsSchema });
/** Network waits never block a local settings change. Apply only if the local edit has not changed. */
export async function syncSandboxSettings(config: ServerConfig, request: typeof fetch = fetch): Promise<void> {
  const existing = rounds.get(config);
  if (existing) return existing;
  const round = (async () => {
    try {
      await ensureFreshPlatformToken(config);
      const connection = await readEigenweltConnection(config);
      const account = sandboxAccount(connection);
      if (!account || !connection.platformToken || !connection.platformURL) { statuses.set(config, "local"); return; }
      statuses.set(config, "syncing");
      const row = await readRuntimeOpencodeConfig(config, SANDBOX_DEFAULT_ID);
      const state = row.sandboxSync?.account === account ? row.sandboxSync : undefined;
      const url = `${connection.platformURL}/api/desktop/settings`;
      const headers = { Authorization: `Bearer ${connection.platformToken}`, "Content-Type": "application/json" };
      let response = await request(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Settings sync unavailable");
      let snapshot = snapshotSchema.parse(await response.json());
      let conflict = false, uploaded = false;
      if (state?.dirty && row.sandbox) {
        // Send the revision this computer actually edited, not the newly fetched one.
        response = await request(url, { method: "PUT", headers, body: JSON.stringify({ revision: state.revision, sandbox: row.sandbox }), signal: AbortSignal.timeout(10000) });
        uploaded = response.ok;
        if (response.status === 409) {
          conflict = true;
          response = await request(url, { headers, signal: AbortSignal.timeout(10000) });
        }
        if (!response.ok) throw new Error("Settings sync unavailable");
        snapshot = snapshotSchema.parse(await response.json());
      }
      await withSandboxSettingsLock(config, async () => {
        // A delayed response must not erase a newer local edit or cross accounts.
        const current = await readRuntimeOpencodeConfig(config, SANDBOX_DEFAULT_ID);
        if (sandboxAccount(await readEigenweltConnection(config)) !== account) return;
        if (current.sandboxEdit !== row.sandboxEdit) {
          // Our own older upload advanced the remote revision. Acknowledge only
          // that revision, keeping the newer local choice queued for upload.
          if (uploaded && current.sandboxSync?.account === account && current.sandboxSync.revision === state?.revision)
            await writeRuntimeOpencodeConfig(config, SANDBOX_DEFAULT_ID, value => ({ ...value,
              sandboxSync: { account, revision: snapshot.revision, dirty: true } }));
          statuses.set(config, "pending");
          return;
        }
        await writeRuntimeOpencodeConfig(config, SANDBOX_DEFAULT_ID, value => ({ ...value, sandbox: snapshot.sandbox,
          sandboxSync: { account, revision: snapshot.revision, dirty: false } }));
        if (row.sandbox?.enabled !== snapshot.sandbox.enabled || row.sandbox?.networkMode !== snapshot.sandbox.networkMode)
          await notifySandboxSettingsChange(config, SANDBOX_DEFAULT_ID);
        statuses.set(config, conflict ? "conflict" : "synced");
      });
    } catch { statuses.set(config, "pending"); }
  })().finally(() => { rounds.delete(config); });
  rounds.set(config, round);
  await round;
}
export function startSandboxSettingsSync(config: ServerConfig): () => void {
  let stopped = false, running = false, pending = false;
  const run = () => {
    if (stopped || config.readOnly) return;
    if (running) { pending = true; return; }
    running = true;
    void syncSandboxSettings(config).finally(() => { running = false; if (pending) { pending = false; run(); } });
  };
  const timer = setInterval(run, 30000);
  timer.unref?.();
  const unsubscribe = onSandboxSettingsChange(async (source, id) => { if (source === config && id === SANDBOX_DEFAULT_ID) run(); });
  run();
  return () => { stopped = true; clearInterval(timer); unsubscribe(); };
}
