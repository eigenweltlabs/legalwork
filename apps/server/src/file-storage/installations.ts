import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { StorageStore } from "./store.js";

const installationSchema = z.object({ workspaceId: z.string(), orgId: z.string(), id: z.string().uuid() });
type Installation = z.infer<typeof installationSchema>;
const pending = new Map<string, Promise<void>>();

/** Only opt-in identifiers are saved here; shared credentials stay in memory. */
export class StorageInstallations {
  readonly path: string;
  constructor(config: ServerConfig) {
    this.path = join(dirname(new StorageStore(config).path), "file-storage-installations.json");
  }
  async list(): Promise<Installation[]> {
    try {
      return z.array(installationSchema).parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw new ApiError(500, "storage_installations_unreadable", "Saved team connection choices could not be read.");
    }
  }
  async set(value: Installation, installed: boolean) {
    const operation = (pending.get(this.path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const entries = (await this.list()).filter(
          (item) => item.workspaceId !== value.workspaceId || item.orgId !== value.orgId || item.id !== value.id,
        );
        if (installed) entries.push(value);
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(entries), { mode: 0o600 });
        await rename(temp, this.path);
      });
    pending.set(this.path, operation);
    try {
      await operation;
    } finally {
      if (pending.get(this.path) === operation) pending.delete(this.path);
    }
  }
}
