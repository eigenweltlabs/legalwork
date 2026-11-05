import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { withFileWriteLock } from "./file-write-lock.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import { engineStorageDir } from "./engine-storage.js";
import type { ServerConfig } from "./types.js";

const legacyPackage = "@opencode-ai/plugin";
const record = z.record(z.string(), z.unknown());
const dependencies = z.record(z.string(), z.string());
const manifestSchema = z.object({ opencode: z.object({
  version: z.literal("2.1.4"),
  runtime: z.literal("released-cli"),
  providedModules: z.array(z.string()).refine(values => values.includes("@opencode/plugin") && values.includes("effect")),
}) });
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

async function readObject(path: string) {
  const text = await readFile(path, "utf8").catch((error: unknown) => { if (missing(error)) return "{}"; throw error; });
  return record.parse(JSON.parse(text));
}

async function writeObject(path: string, value: Record<string, unknown>) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Retire only the SDK managed by the old bootstrap. V2 supplies plugin/effect
 * inside its host; installing another instance breaks native registrations. */
async function retireManagedV1Sdk(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch((error: unknown) => { if (missing(error)) return null; throw error; });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Managed engine configuration is not a local directory: ${directory}`);
  return withFileWriteLock(join(directory, "package.json"), async () => {
    // Validate every file before mutations. Preserve malformed files for repair.
    const current = await readObject(join(directory, "package.json"));
    const lock = await readObject(join(directory, "package-lock.json"));
    const currentDependencies = dependencies.parse(current.dependencies ?? {});
    const packages = z.record(z.string(), record).parse(lock.packages ?? {});
    const root = packages[""] ?? {};
    const rootDependencies = dependencies.parse(root.dependencies ?? {});
    const target = join(directory, "node_modules", legacyPackage);
    const installed = await lstat(target).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (installed && !installed.isSymbolicLink()) {
      const identity = await readObject(join(target, "package.json"));
      if (identity.name !== legacyPackage) throw new Error(`Refusing to remove an unknown managed dependency: ${target}`);
    }
    const changed = Boolean(currentDependencies[legacyPackage] || rootDependencies[legacyPackage] || packages[`node_modules/${legacyPackage}`] || installed);
    if (!changed) return false;
    delete currentDependencies[legacyPackage];
    delete rootDependencies[legacyPackage];
    delete packages[`node_modules/${legacyPackage}`];
    if (current.dependencies !== undefined) await writeObject(join(directory, "package.json"), { ...current, dependencies: currentDependencies });
    if (lock.packages !== undefined) await writeObject(join(directory, "package-lock.json"), { ...lock, packages: { ...packages, "": { ...root, dependencies: rootDependencies } } });
    if (installed) await rm(target, { recursive: true, force: true });
    return true;
  });
}

/** Native plugins use the released CLI's virtual modules. Never install an SDK
 * at engine startup, including fresh/offline profiles. Validate the packaged
 * declaration before retiring the app-owned v1 dependency. */
export async function prepareManagedOpencodeDependencies(config: ServerConfig, sdkDirectory?: string) {
  if (!config.agentSandboxEnabled) return { seeded: false, reason: "unmanaged" };
  const bundle = sdkDirectory ?? (process.resourcesPath
    ? join(process.resourcesPath, "opencode-sdk")
    : fileURLToPath(new URL("../../desktop/resources/opencode-sdk", import.meta.url)));
  const manifest = await readFile(join(bundle, "package.json"), "utf8").catch((error: unknown) => {
    if (missing(error) && sdkDirectory === undefined && !process.resourcesPath) return null;
    throw new Error(`Bundled OpenCode runtime declaration is missing at ${bundle}. Repair the app installation or prepare desktop resources.`, { cause: error });
  });
  if (manifest === null) return { seeded: false, reason: "bundle-unavailable" };
  const parsed = manifestSchema.safeParse(JSON.parse(manifest));
  if (!parsed.success) throw new Error("Bundled OpenCode runtime declaration must match released engine 2.1.4 and its host-provided plugin/effect modules");
  const home = join(engineStorageDir(config), "engine-home");
  const directories = [join(home, "config", "opencode"), orgPolicyEngineDir(config), join(home, ".opencode")];
  const retired: string[] = [];
  for (const directory of directories) if (await retireManagedV1Sdk(directory)) retired.push(directory);
  return { seeded: false, reason: "host-provided", version: parsed.data.opencode.version, retired };
}
