import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { opencodeRelease } from "../electron/opencode-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The engine provides these modules itself. Their ABI follows the official
 * base release, including when the executable has a distinct derivative identity. */
export async function stageOpencodeSdk({ sourcePackage, destination, expectedVersion }) {
  const manifest = JSON.parse(await readFile(join(sourcePackage, "package.json"), "utf8"));
  if (manifest.name !== "@opencode/plugin" || manifest.version !== expectedVersion || expectedVersion !== opencodeRelease.version) {
    throw new Error(`OpenCode plugin SDK must match engine API ${opencodeRelease.version}; received ${expectedVersion}`);
  }
  // Remove the old v1 dependency tree: loading a foreign effect/plugin copy is
  // explicitly rejected by the v2 host, even if its version happens to match.
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "package.json"), JSON.stringify({
    private: true,
    opencode: { version: expectedVersion, runtime: "released-cli", providedModules: ["@opencode/plugin", "effect"] },
  }, null, 2) + "\n");
  return { version: expectedVersion, packages: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await stageOpencodeSdk({
    sourcePackage: join(repoRoot, "apps/server/node_modules/@opencode/plugin"),
    destination: join(repoRoot, "apps/desktop/resources/opencode-sdk"),
    expectedVersion: opencodeRelease.version,
  });
  console.log(`Declared OpenCode ${result.version} host-provided plugin runtime; no foreign module copies.`);
}
