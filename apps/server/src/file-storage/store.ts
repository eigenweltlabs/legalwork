import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { StorageConnection, StorageInput, StorageSecretKey } from "@legalwork/types/file-storage";
import { storageInputSchema, storageSecretKeys } from "./schema.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";

const storedSchema = storageInputSchema.extend({
  id: z.string().uuid(),
  workspaceId: z.string(),
  updatedAt: z.number(),
});
export type StoredStorage = z.infer<typeof storedSchema>;
const pending = new Map<string, Promise<unknown>>();

export class StorageStore {
  readonly path: string;
  constructor(config: ServerConfig) {
    this.path =
      process.env.LEGALWORK_STORAGE_STORE ||
      join(
        config.configPath ? dirname(resolve(config.configPath)) : join(homedir(), ".config", "legalwork"),
        "file-storage.json",
      );
  }
  private async all(): Promise<StoredStorage[]> {
    try {
      return z.array(storedSchema).parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw new ApiError(500, "storage_configuration_unreadable", "The saved storage configuration could not be read.");
    }
  }
  async list(workspaceId: string) {
    return (await this.all()).filter((item) => item.workspaceId === workspaceId);
  }
  async get(workspaceId: string, id: string) {
    const item = (await this.list(workspaceId)).find((item) => item.id === id);
    if (!item)
      throw new ApiError(
        404,
        "storage_not_found",
        "This storage connection was removed or is not available in this workspace.",
      );
    return item;
  }
  private async mutate(fn: (items: StoredStorage[]) => StoredStorage[]) {
    const operation = (pending.get(this.path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const items = fn(await this.all());
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(items), { mode: 0o600 });
        await rename(tmp, this.path);
        await chmod(this.path, 0o600);
      });
    pending.set(this.path, operation);
    try {
      await operation;
    } finally {
      if (pending.get(this.path) === operation) pending.delete(this.path);
    }
  }
  async save(workspaceId: string, input: StorageInput, id?: string) {
    const connection = { ...input, workspaceId, id: id ?? randomUUID(), updatedAt: Date.now() };
    await this.mutate((items) => {
      if (id && !items.some((item) => item.id === id && item.workspaceId === workspaceId))
        throw new ApiError(404, "storage_not_found", "Storage connection was removed.");
      return id ? items.map((item) => (item.id === id ? connection : item)) : [...items, connection];
    });
    return publicConnection(connection);
  }
  async remove(workspaceId: string, id: string) {
    await this.get(workspaceId, id);
    await this.mutate((items) => items.filter((item) => item.id !== id || item.workspaceId !== workspaceId));
  }
}

export function publicConnection(item: StoredStorage): StorageConnection {
  const { secrets, workspaceId: _workspaceId, ...publicFields } = item;
  const configuredSecrets: StorageSecretKey[] = storageSecretKeys.filter((key) => Boolean(secrets[key]));
  return { ...publicFields, configuredSecrets };
}

export function mergeStorageSecrets(input: StorageInput, previous?: StoredStorage): StorageInput {
  const secrets =
    previous?.config.kind === input.config.kind ? { ...previous.secrets, ...input.secrets } : input.secrets;
  return { ...input, secrets };
}
