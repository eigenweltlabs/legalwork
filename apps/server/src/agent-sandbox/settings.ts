import { randomUUID } from "node:crypto";
import { type NetworkMode } from "./network.js";
export { networkModeSchema, type NetworkMode } from "./network.js";
export { sandboxSettingsSchema, type SandboxSettings } from "./settings-schema.js";
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from "./settings-schema.js";
import type { ServerConfig } from "../types.js";
import { GLOBAL_TOOL_PERMISSIONS_ID, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";

const locks = new WeakMap<ServerConfig, Promise<unknown>>();
export function withSandboxSettingsLock<T>(config: ServerConfig, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(config) ?? Promise.resolve()).catch(() => {}).then(work);
  locks.set(config, next);
  return next;
}
export const SANDBOX_DEFAULT_ID = "__sandbox_default__";
export const sandboxSessionId = (workspace: string, session: string) => `__sandbox_session__${JSON.stringify([workspace, session])}`;
type Listener = (config: ServerConfig, id: string) => Promise<void>;
const listeners = new Set<Listener>();
export function onSandboxSettingsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export async function notifySandboxSettingsChange(config: ServerConfig, id: string): Promise<void> {
  await Promise.all([...listeners].map(listener => listener(config, id)));
}
export async function readSandboxDefault(config: ServerConfig): Promise<SandboxSettings> {
  const row = await readRuntimeOpencodeConfig(config, SANDBOX_DEFAULT_ID);
  // Earlier versions saved only a network choice, not consent to enable the sandbox.
  return row.sandbox ?? { ...DEFAULT_SANDBOX_SETTINGS, networkMode: await readSandboxNetworkMode(config) };
}
export async function readSandboxNetworkMode(config: ServerConfig): Promise<NetworkMode> {
  const row = await readRuntimeOpencodeConfig(config, SANDBOX_DEFAULT_ID);
  return row.sandbox?.networkMode ?? (await readRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID)).sandboxNetworkMode ?? "approve";
}
export async function writeSandboxDefault(config: ServerConfig, settings: SandboxSettings, account?: string | null): Promise<void> {
  await withSandboxSettingsLock(config, async () => {
    await writeRuntimeOpencodeConfig(config, SANDBOX_DEFAULT_ID, row => ({ ...row, sandbox: settings, sandboxEdit: randomUUID(),
      sandboxSync: account === undefined ? (row.sandboxSync ? { ...row.sandboxSync, dirty: true } : undefined)
        : account ? { account, revision: row.sandboxSync?.account === account ? row.sandboxSync.revision : 0, dirty: true } : undefined }));
    await notifySandboxSettingsChange(config, SANDBOX_DEFAULT_ID);
  });
}
export async function writeSandboxNetworkMode(config: ServerConfig, mode: NetworkMode): Promise<void> {
  await writeSandboxDefault(config, { ...await readSandboxDefault(config), networkMode: mode });
}
export async function writeSessionSandbox(config: ServerConfig, workspace: string, session: string, settings: SandboxSettings | null): Promise<void> {
  const id = sandboxSessionId(workspace, session);
  await writeRuntimeOpencodeConfig(config, id, () => settings ? { sandbox: settings } : {});
  await notifySandboxSettingsChange(config, id);
}
/** Lineage is resolved from the engine by the server, never supplied by the agent. */
export async function effectiveSandbox(config: ServerConfig, workspace: string, lineage: string[]) {
  const dependencies: string[] = [];
  for (const session of lineage) {
    const id = sandboxSessionId(workspace, session);
    dependencies.push(id);
    const row = await readRuntimeOpencodeConfig(config, id);
    if (row.sandbox) return { ...row.sandbox, source: session === lineage[0] ? "session" : "parent", dependencies };
  }
  return { ...await readSandboxDefault(config), source: "application", dependencies: [...dependencies, SANDBOX_DEFAULT_ID] };
}
