import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { atomicPrivateFile, missingFile } from "../connectors/storage-state.js";
import { appliedOrgPolicy } from "../org-policy.js";
import { RisClient, type RisClientOptions } from "../ris/client/ris-client.js";
import { RisError } from "../ris/infrastructure/errors.js";
import { risTools } from "../ris/tools.js";

const settingsSchema = z.object({ enabled: z.boolean() }).strict();
export const risSettingsPath = (config: ServerConfig) => join(config.configPath ? dirname(resolve(config.configPath)) : join(homedir(), ".config", "legalwork"), "ris.json");
const running = new Map<string, Set<AbortController>>();

async function settings(config: ServerConfig) {
  try { return settingsSchema.parse(JSON.parse(await readFile(risSettingsPath(config), "utf8"))); }
  catch (error) {
    if (missingFile(error)) return { enabled: false };
    throw new ApiError(503, "ris_settings_unreadable", "RIS settings could not be read. Restore or reset the integration settings.");
  }
}

export async function risStatus(config: ServerConfig) {
  const allowed = (await appliedOrgPolicy(config, "extensions.builtIn"))?.value.ris !== false;
  return { ...await settings(config), allowed, readOnly: config.readOnly === true, source: "https://www.ris.bka.gv.at/", requiresAuthentication: false };
}

export async function saveRisSettings(config: ServerConfig, input: unknown) {
  if (config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "RIS enabled must be true or false.");
  if (parsed.data.enabled && !(await risStatus(config)).allowed)
    throw new ApiError(403, "org_policy_disallowed", "Your organization has switched off Austrian RIS.");
  await atomicPrivateFile(risSettingsPath(config), JSON.stringify(parsed.data));
  if (!parsed.data.enabled) for (const controller of running.get(risSettingsPath(config)) ?? []) controller.abort();
  return risStatus(config);
}

async function requireEnabled(config: ServerConfig) {
  const state = await risStatus(config);
  if (!state.allowed) throw new ApiError(403, "org_policy_disallowed", "Your organization has switched off Austrian RIS.");
  if (!state.enabled) throw new ApiError(409, "ris_disabled", "Enable Austrian RIS in Settings > Integrations > Legal databases before using its tools.");
}

async function runRis<T>(config: ServerConfig, execute: (client: RisClient) => Promise<T>, options: RisClientOptions = {}) {
  await requireEnabled(config);
  const key = risSettingsPath(config), controller = new AbortController();
  const current = running.get(key) ?? new Set<AbortController>();
  current.add(controller); running.set(key, current);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
  try {
    return await execute(new RisClient({ ...options, signal, assertAllowed: () => requireEnabled(config) }));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof RisError) throw new ApiError(error.code === "not_found" ? 404 : error.code === "validation_error" || error.code === "bulk_fetch_refused" ? 400 : error.code === "rate_limited" ? 429 : 502,
      `ris_${error.code}`, error.message, error.details);
    if (signal.aborted) throw new ApiError(408, "ris_cancelled", "RIS operation was cancelled or timed out. Select a specific database or narrow the query before retrying.");
    throw new ApiError(502, "ris_invalid_result", "RIS could not return a verified result. Try again or open the original RIS source.");
  } finally { current.delete(controller); if (!current.size) running.delete(key); }
}

export async function testRisConnection(config: ServerConfig, signal?: AbortSignal) {
  const result = await runRis(config, client => client.health(), { signal });
  return { ok: result.ok, checkedAt: new Date().toISOString() };
}

export async function callRisAction(config: ServerConfig, action: string, args: unknown, signal?: AbortSignal) {
  return runRis(config, async client => {
    const tool = risTools(client).find(value => value.action === action);
    if (!tool) throw new ApiError(404, "extension_action_not_found", "RIS action not found.");
    return { ok: true, extensionId: "ris", action, result: await tool.run(args) };
  }, { signal });
}
