import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { connectorDefinitions, connectorSettingsSchema } from "./schema.js";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { oauthVaultPath, vaultLock } from "../file-storage/oauth/vault.js";
import { connectorDefinition } from "./definition.js";
import { synchronizeConnectorBindings } from "./sync.js";

export const connectorSettingsPath = (config: ServerConfig) => join(dirname(oauthVaultPath(config)), "connector-settings.json");
const defaults = () => connectorSettingsSchema.parse({ writeAccess: {} });
const legacyGlobalSetting = z.object({ writeAccess: z.boolean() }).strict();
export async function connectorSettings(config: ServerConfig) {
  if (config.cloudSync?.role === "executor") {
    const bindings = await synchronizeConnectorBindings(config);
    const result = defaults();
    for (const binding of bindings.filter(item => !item.deleted)) for (const [id, policy] of Object.entries(binding.policies)) {
      if (!policy.active || !policy.cloudEnabled) continue;
      result.writeAccess = { ...result.writeAccess, [id]: policy.writeAccess };
      if (id === "outlook" || id === "outlook-calendar") result.activeAccounts[id] = binding.id;
    }
    return connectorSettingsSchema.parse(result);
  }
  try {
    const saved: unknown = JSON.parse(await readFile(connectorSettingsPath(config), "utf8"));
    // A prior global flag never authorizes an individual connector.
    return legacyGlobalSetting.safeParse(saved).success ? defaults() : connectorSettingsSchema.parse(saved);
  }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return defaults();
    throw new ApiError(500, "connector_settings_unreadable", "Connector settings could not be read.");
  }
}
export async function saveConnectorSettings(config: ServerConfig, input: unknown) {
  if (config.cloudSync?.role === "executor") throw new ApiError(403, "connector_desktop_required", "Manage connector permissions from your desktop.");
  if (config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
  const parsed = connectorSettingsSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Invalid connector settings.");
  const path = connectorSettingsPath(config);
  return vaultLock(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(parsed.data), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    return parsed.data;
  });
}
export async function ensureConnectorWritesAllowed(config: ServerConfig, id: string) {
  if (config.cloudSync?.role === "executor") await synchronizeConnectorBindings(config, { force: true });
  if (config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
  if (!(await connectorWriteSetting(config, id)).writeAccess) throw new ApiError(403, "connector_writes_disabled", "Enable write access for this connector in Settings → Integrations → Connectors before making changes to its account.");
}
export async function connectorWriteSetting(config: ServerConfig, id: string) {
  if (!connectorDefinitions.some((item) => item.id === id)) throw new ApiError(404, "connector_not_found", "Connector not found.");
  const settings = await connectorSettings(config);
  const entry = Object.entries(settings.writeAccess).find(([key]) => key === id);
  return { writeAccess: entry?.[1] === true, readOnly: config.readOnly || config.cloudSync?.role === "executor" };
}
export async function saveConnectorWriteSetting(config: ServerConfig, id: string, input: unknown) {
  const parsed = z.object({ writeAccess: z.boolean() }).strict().safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Connector write access must be enabled or disabled.");
  await connectorWriteSetting(config, id);
  // Serialize read-modify-write across connector toggles on this profile.
  await vaultLock(`${connectorSettingsPath(config)}:update`, async () => {
    const previous = await connectorSettings(config);
    await saveConnectorSettings(config, { ...previous, writeAccess: { ...previous.writeAccess, [id]: parsed.data.writeAccess } });
  });
  return connectorWriteSetting(config, id);
}
export async function connectorOAuthWriteIds(config: ServerConfig, id: string) {
  if (config.readOnly) return [];
  const siblings = id === "outlook" || id === "outlook-calendar" ? ["outlook", "outlook-calendar"] : [id];
  const settings = await connectorSettings(config);
  return siblings.filter((key) => Object.entries(settings.writeAccess).some(([name, enabled]) => name === key && enabled));
}

function sharesOutlookAccount(id: string): id is "outlook" | "outlook-calendar" {
  return id === "outlook" || id === "outlook-calendar";
}
export async function connectorIsActivated(config: ServerConfig, id: string, connectionId: string) {
  return !sharesOutlookAccount(id) || (await connectorSettings(config)).activeAccounts[id] === connectionId;
}
export async function requireConnectorActivated(config: ServerConfig, id: string, connectionId: string) {
  if (!await connectorIsActivated(config, id, connectionId)) throw new ApiError(403, "connector_inactive", `Activate ${connectorDefinition(id).name} in Integrations before using its tools.`);
}
export async function recordConnectorActivation(config: ServerConfig, id: string, connectionId: string, active: boolean) {
  if (!sharesOutlookAccount(id)) return;
  await vaultLock(`${connectorSettingsPath(config)}:update`, async () => {
    const previous = await connectorSettings(config);
    const activeAccounts = { ...previous.activeAccounts };
    if (active) activeAccounts[id] = connectionId;
    else if (activeAccounts[id] === connectionId) delete activeAccounts[id];
    await saveConnectorSettings(config, { ...previous, activeAccounts });
  });
}
export async function clearConnectorActivation(config: ServerConfig, id: string, connectionId: string) {
  if (!sharesOutlookAccount(id)) return;
  await vaultLock(`${connectorSettingsPath(config)}:update`, async () => {
    const previous = await connectorSettings(config);
    const activeAccounts = { ...previous.activeAccounts };
    if (activeAccounts.outlook === connectionId) delete activeAccounts.outlook;
    if (activeAccounts["outlook-calendar"] === connectionId) delete activeAccounts["outlook-calendar"];
    if (JSON.stringify(previous.activeAccounts) !== JSON.stringify(activeAccounts)) await saveConnectorSettings(config, { ...previous, activeAccounts });
  });
}
