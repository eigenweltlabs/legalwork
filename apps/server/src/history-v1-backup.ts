import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { engineStorageDir } from "./engine-storage.js";
import type { ServerConfig } from "./types.js";

const Manifest = z.object({ version: z.literal(1), source: z.string(), createdAt: z.number(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() });
export type LegacyHistoryBackup = z.infer<typeof Manifest> & { path: string };
export const legacyHistoryBackupDirectory = (config: ServerConfig) => join(engineStorageDir(config), "history-v1");
const verified = new Map<string, { identity: string; backup: LegacyHistoryBackup }>();
export async function hashHistoryFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Read-only, content-verified source independent of upstream legacy-table cleanup. */
export async function readLegacyHistoryBackup(config: ServerConfig): Promise<LegacyHistoryBackup | null> {
  const directory = legacyHistoryBackupDirectory(config);
  let directoryStat;
  try { directoryStat = await lstat(directory); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null; throw error; }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Historical backup directory is invalid");
  const path = join(directory, "original.db"), manifestPath = join(directory, "manifest.json");
  const [file, manifestFile] = await Promise.all([lstat(path), lstat(manifestPath)]);
  if (!file.isFile() || file.isSymbolicLink() || !manifestFile.isFile() || manifestFile.isSymbolicLink()) throw new Error("Historical backup files are invalid");
  const identity = [file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs, manifestFile.size, manifestFile.mtimeMs, manifestFile.ctimeMs].join(":");
  const cached = verified.get(path);
  if (cached?.identity === identity) return cached.backup;
  const manifest = Manifest.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (file.size !== manifest.bytes || await hashHistoryFile(path) !== manifest.sha256) throw new Error("Historical backup integrity check failed");
  const backup = { ...manifest, path };
  verified.set(path, { identity, backup });
  return backup;
}

/** The callback must create a consistent SQLite snapshot, including its WAL. */
export async function ensureLegacyHistoryBackup(config: ServerConfig, source: string, snapshot: (destination: string) => Promise<void>): Promise<LegacyHistoryBackup> {
  const existing = await readLegacyHistoryBackup(config);
  if (existing) return existing;
  const directory = legacyHistoryBackupDirectory(config), staging = `${directory}.staging-${randomUUID()}`;
  await mkdir(engineStorageDir(config), { recursive: true, mode: 0o700 });
  await mkdir(staging, { mode: 0o700 });
  try {
    const path = join(staging, "original.db");
    await snapshot(path);
    await chmod(path, 0o400);
    const manifest = { version: 1, source, createdAt: Date.now(), sha256: await hashHistoryFile(path), bytes: (await lstat(path)).size };
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest) + "\n", { mode: 0o400, flag: "wx" });
    try { await rename(staging, directory); }
    catch (error) {
      // Another process can publish the same first-run backup concurrently.
      if (!(error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code)))) throw error;
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
  const backup = await readLegacyHistoryBackup(config);
  if (!backup) throw new Error("Historical backup publication failed");
  return backup;
}
