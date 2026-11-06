import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { oauthVaultPath } from "../file-storage/oauth/vault.js";
import type { ServerConfig } from "../types.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const connectorStorageStateSchema = z.object({
  version: z.literal(1), phase: z.enum(["retiring", "complete"]),
  connections: z.array(digest), settingsExpected: z.boolean(),
  legacySourceDigest: digest.optional(),
  pending: z.object({ key: digest, present: z.boolean() }).optional(),
}).strict();
export type ConnectorStorageState = z.infer<typeof connectorStorageStateSchema>;
export const connectorStorageStatePath = (config: ServerConfig) => join(dirname(oauthVaultPath(config)), "connector-storage-state.json");
export const connectorEntryDigest = (key: string) => createHash("sha256").update(key).digest("hex");
export const missingFile = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
export async function atomicPrivateFile(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function readConnectorStorageState(config: ServerConfig) {
  try { return connectorStorageStateSchema.parse(JSON.parse(await readFile(connectorStorageStatePath(config), "utf8"))); }
  catch (error) {
    if (missingFile(error)) return undefined;
    throw new ApiError(503, "connector_storage_state_unreadable", "Connected-account storage state could not be read. Restore the original profile before reconnecting.");
  }
}
export async function requireConnectorStorageState(config: ServerConfig) {
  const state = await readConnectorStorageState(config);
  if (!state) throw new ApiError(503, "connector_storage_upgrade_required", "Connected-account storage must be prepared during server startup before using connectors.");
  return state;
}
export async function writeConnectorStorageState(config: ServerConfig, state: ConnectorStorageState) {
  await atomicPrivateFile(connectorStorageStatePath(config), JSON.stringify(connectorStorageStateSchema.parse(state)));
}
