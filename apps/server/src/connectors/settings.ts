import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { connectorDefinitions, connectorSettingsSchema } from "./schema.js";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { oauthVaultPath, vaultLock } from "../file-storage/oauth/vault.js";
import { connectorDefinition } from "./definition.js";
import { atomicPrivateFile, connectorStorageStatePath, missingFile, requireConnectorStorageState, writeConnectorStorageState } from "./storage-state.js";
import { invalidateConnectorCredentials } from "./credential-cache.js";

export const connectorSettingsPath = (config: ServerConfig) => join(dirname(oauthVaultPath(config)), "connector-settings.json");
const defaults = () => connectorSettingsSchema.parse({ writeAccess: {} });
const legacyGlobalSetting = z.object({ writeAccess: z.boolean() }).strict();
/** Explicit startup import; ordinary settings reads accept only today's format. */
export async function prepareConnectorSettings(config: ServerConfig, expected: boolean, allowLegacy = false) {
  const path = connectorSettingsPath(config);
  let original: string;
  try { original = await readFile(path, "utf8"); }
  catch (error) {
    if (missingFile(error) && !expected) return false;
    throw new ApiError(503, "connector_settings_missing", "The established connector permission settings are missing. Restore the original settings before using connectors.");
  }
  let saved: unknown;
  try { saved = JSON.parse(original); } catch { throw new ApiError(500, "connector_settings_unreadable", "Connector settings could not be read."); }
  const legacy = legacyGlobalSetting.safeParse(saved);
  if (!legacy.success) {
    if (!connectorSettingsSchema.safeParse(saved).success) throw new ApiError(500, "connector_settings_unreadable", "Connector settings could not be read.");
    return true;
  }
  if (!allowLegacy) throw new ApiError(503, "connector_settings_unreadable", "Current connector settings were replaced by a retired format. Restore the current settings; the original file has been preserved.");
  const hash = createHash("sha256").update(original).digest("hex");
  const backup = `${path}.legacy-${hash}.json`;
  try { if (await readFile(backup, "utf8") !== original) throw new Error("Source backup conflict"); }
  catch (error) { if (!missingFile(error)) throw error; await atomicPrivateFile(backup, original); }
  await atomicPrivateFile(`${backup}.import.json`, JSON.stringify({ version: 1, sourceDigest: hash,
    previousFormat: "global-write-access", currentFormat: "per-connector-write-access", effectiveAccess: "all-deny",
    note: "The retired global flag never authorized an individual connector. Migration preserves that effective behavior; permissions remain independently configurable." }));
  await atomicPrivateFile(path, JSON.stringify(defaults()));
  return true;
}
export async function connectorSettings(config: ServerConfig) {
  const state = await requireConnectorStorageState(config);
  try { return connectorSettingsSchema.parse(JSON.parse(await readFile(connectorSettingsPath(config), "utf8"))); }
  catch (error) {
    if (missingFile(error) && !state.settingsExpected) return defaults();
    if (missingFile(error)) throw new ApiError(503, "connector_settings_missing", "The established connector permission settings are missing. Restore the original settings before using connectors.");
    throw new ApiError(500, "connector_settings_unreadable", "Connector settings could not be read.");
  }
}
export async function saveConnectorSettings(config: ServerConfig, input: unknown) {
  if (config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
  const parsed = connectorSettingsSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Invalid connector settings.");
  return vaultLock(connectorStorageStatePath(config), async () => {
    const state = await requireConnectorStorageState(config);
    if (state.settingsExpected) {
      try { await stat(connectorSettingsPath(config)); }
      catch { throw new ApiError(503, "connector_settings_missing", "The established connector permission settings are missing. Restore the original settings before using connectors."); }
    }
    await writeConnectorStorageState(config, { ...state, settingsExpected: true });
    invalidateConnectorCredentials(config);
    await atomicPrivateFile(connectorSettingsPath(config), JSON.stringify(parsed.data));
    return parsed.data;
  });
}
export async function ensureConnectorWritesAllowed(config: ServerConfig, id: string) {
  if (config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
  if (!(await connectorWriteSetting(config, id)).writeAccess) throw new ApiError(403, "connector_writes_disabled", "Enable write access for this connector in Settings → Integrations → Connectors before making changes to its account.");
}
export async function connectorWriteSetting(config: ServerConfig, id: string) {
  if (!connectorDefinitions.some((item) => item.id === id)) throw new ApiError(404, "connector_not_found", "Connector not found.");
  const settings = await connectorSettings(config);
  const entry = Object.entries(settings.writeAccess).find(([key]) => key === id);
  return { writeAccess: entry?.[1] === true, readOnly: config.readOnly };
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
