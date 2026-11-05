import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { canonicalFilePath } from "./file-write-lock.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

/** Host-only snapshot. Persist the namespace, never this connection capability. */
export type ManagedImageAffinity = Readonly<{
  storageNamespace: string;
  connectionGeneration: object;
}>;

type Connection = { url: string; username: string; password: string };
type Defaults = Pick<ServerConfig, "opencodeBaseUrl" | "opencodeUsername" | "opencodePassword">;

/** The actual managed database defines a history namespace across native restarts.
 * Endpoint equality only proves that a workspace currently uses our owned engine;
 * a saved manual URL cannot create a namespace or a connection capability. */
export async function createManagedImageAffinity(config: Defaults, database: string) {
  // A first launch may not have created the database yet. This identifies the
  // host's chosen history path; connect verifies the real file after startup.
  const canonicalDatabase = await canonicalFilePath(database);
  const storageNamespace = `managed-history:${createHash("sha256").update("legalwork-managed-history-v1\0").update(canonicalDatabase).digest("hex")}`;
  let current: { url: string; authHeader: string; affinity: ManagedImageAffinity } | undefined;
  let generation = 0;
  return {
    storageNamespace,
    async connect(connection: Connection) {
      current = undefined;
      const connectingGeneration = ++generation;
      if (!connection.url || !connection.username || !connection.password) throw new Error("Managed image history requires an authenticated owned connection.");
      const actualDatabase = await realpath(database);
      if (actualDatabase !== canonicalDatabase || !(await stat(actualDatabase)).isFile())
        throw new Error("Managed image history database path changed or is not a regular file.");
      if (connectingGeneration !== generation) throw new Error("Managed image connection changed during history binding.");
      current = {
        url: connection.url,
        authHeader: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        affinity: Object.freeze({ storageNamespace, connectionGeneration: Object.freeze({}) }),
      };
    },
    disconnect() { generation++; current = undefined; },
    resolve(workspace: WorkspaceInfo): ManagedImageAffinity | undefined {
      if (!current) return undefined;
      const connection = resolveWorkspaceOpencodeConnection(config, workspace);
      return connection.baseUrl === current.url && connection.authHeader === current.authHeader ? current.affinity : undefined;
    },
  };
}
