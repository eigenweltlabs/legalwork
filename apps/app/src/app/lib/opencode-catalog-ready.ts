import type { ModelListOutput } from "@opencode/client";
import type { Client } from "../types";

let catalogs = new WeakMap<Client, Map<string, Promise<ModelListOutput>>>();
/** A released-host model catalog read activates external native plugins. Other
 * metadata endpoints alone do not establish that their registrations exist. */
export function ensureNativeCatalogReady(client: Client, directory?: string): Promise<ModelListOutput> {
  const key = directory?.trim() ?? "";
  const locations = catalogs.get(client) ?? new Map<string, Promise<ModelListOutput>>();
  catalogs.set(client, locations);
  const current = locations.get(key);
  if (current) return current;
  const pending = client.model.list({ location: key ? { directory: key } : undefined }).catch(error => {
    if (locations.get(key) === pending) locations.delete(key);
    throw error;
  });
  locations.set(key, pending);
  return pending;
}
/** Native change events and reconnects invalidate snapshots, never session content. */
export function invalidateNativeCatalogReady(client?: Client, directory?: string) {
  if (!client) { catalogs = new WeakMap(); return; }
  if (directory === undefined) catalogs.delete(client);
  else catalogs.get(client)?.delete(directory.trim());
}
