import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { runtimeDbPath } from "../runtime-db.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { CloudReplica, readCloudSyncConfig } from "./replica.js";
import { recoverCheckpointRestore } from "./state.js";

const LockSchema = z.object({ pid: z.number().int().positive(), host: z.string(), boot: z.string().optional() });
const lockPath = (config: ServerConfig) => join(dirname(runtimeDbPath(config)), "cloud-sync-running.json");
async function bootId() { try { return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); } catch { return hostname(); } }

export async function assertSyncOffline(config: ServerConfig) {
  const path = lockPath(config);
  if (existsSync(path)) {
    const lock = LockSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (lock.host === hostname() && (!lock.boot || lock.boot === await bootId())) {
      let alive = true;
      try { process.kill(lock.pid, 0); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false; else throw error; }
      if (alive) throw new ApiError(409, "sync_runtime_running", "Stop LegalWork before restoring or handing its sessions to another VM.");
    }
    await rm(path, { force: true });
  }
  // Also catches an older server started before it knew about runtime locks.
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) });
    if (response.ok) throw new ApiError(409, "sync_runtime_running", "Stop the running LegalWork server before restoring state.");
  } catch (error) { if (error instanceof ApiError) throw error; }
}

/** Called before engine launch, not from the VM template build. */
export async function bootCloudSync(config: ServerConfig) {
  const path = process.env.LEGALWORK_CLOUD_SYNC_CONFIG?.trim();
  if (!path) {
    if (existsSync(join(dirname(runtimeDbPath(config)), "cloud-sync-restore", "pending.json"))) {
      await assertSyncOffline(config);
      await recoverCheckpointRestore(config);
    }
    return null;
  }
  await assertSyncOffline(config);
  const settings = await readCloudSyncConfig(path);
  if (settings.role === "executor" && (config.opencodeBaseUrl || process.env.OPENCODE_DB?.trim() || process.env.LEGALWORK_DEV_MODE === "1"))
    throw new ApiError(409, "sync_managed_engine", "Cloud execution requires the managed private engine database without an external engine or development database override.");
  const replica = await CloudReplica.open(config, settings);
  try {
    if (settings.role === "executor") {
      await replica.acquire();
      await replica.restore();
    }
    await replica.syncFiles();
    await replica.syncPreferences();
    await mkdir(dirname(lockPath(config)), { recursive: true });
    await writeFile(lockPath(config), JSON.stringify({ pid: process.pid, host: hostname(), boot: await bootId() }), { flag: "wx", mode: 0o600 });
    const stop = replica.start();
    return { replica, async stop() { try { await stop(); } finally { await rm(lockPath(config), { force: true }); } } };
  } catch (error) { await replica.release().catch(() => {}); replica.close(); throw error; }
}

export async function prepareCloudExecution(config: ServerConfig, workspaceId: string) {
  const sync = config.cloudSync;
  if (!sync) return;
  if (!sync.canExecute()) throw new ApiError(409, "sync_execution_owner", "The assistant runs on its cloud execution owner. Connect to that worker to continue this session.");
  await sync.prepareWorkspace(workspaceId);
  if (!sync.canExecute()) throw new ApiError(409, "sync_lease_lost", "Execution ownership expired while the project was syncing.");
}

export function cloudExecutionFetch(config: ServerConfig, workspace: WorkspaceInfo, upstream: typeof fetch): typeof fetch {
  return Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && /^\/(session|permission)(\/|$)/.test(new URL(request.url).pathname)) {
      await prepareCloudExecution(config, workspace.id);
      return config.cloudSync?.runEngineRequest ? config.cloudSync.runEngineRequest(() => upstream(request)) : upstream(request);
    }
    return upstream(request);
  }, { preconnect: fetch.preconnect });
}
