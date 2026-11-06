import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

/** An explicit legacy-file import retains exact source bytes before editing it.
 * Files stay in private app storage, outside every case/capability directory. */
export async function backupRuntimeConfigSource(config: Pick<ServerConfig, "configPath">, workspaceId: string, sourcePath: string) {
  const content = await readFile(sourcePath);
  const digest = createHash("sha256").update(content).digest("hex");
  const directory = join(runtimeStorageDir(config), "configuration-import-backups", createHash("sha256").update(workspaceId).digest("hex"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `${createHash("sha256").update(sourcePath).digest("hex")}-${digest}`;
  const path = join(directory, `${name}.original`);
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
  if (!(await readFile(path)).equals(content)) throw new Error("The saved configuration backup does not match its source.");
  const metadata = join(directory, `${name}.json`);
  try { await writeFile(metadata, JSON.stringify({ version: 1, workspaceId, sourcePath, sha256: digest, backup: path }, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
  const saved: unknown = JSON.parse(await readFile(metadata, "utf8"));
  if (!saved || typeof saved !== "object" || Reflect.get(saved, "sourcePath") !== sourcePath || Reflect.get(saved, "workspaceId") !== workspaceId || Reflect.get(saved, "sha256") !== digest || Reflect.get(saved, "backup") !== path) throw new Error("Saved configuration backup provenance is invalid.");
  return { path, sha256: digest };
}
