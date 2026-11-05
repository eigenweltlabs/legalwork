import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import release from "./release.json" with { type: "json" };
import recipe from "./build/recipe.json" with { type: "json" };
import { assembleDerivativeDistribution } from "./build/distribution.mjs";
import { sourcePolicySha256, recipePolicySha256 } from "./build-policy.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export const officialFixtureSelection = { schemaVersion: 1, kind: "official", version: release.version, baseVersion: release.version };

/** Each fixture owns its module registry and selector; production modules and
 * native-engine tests never receive a process-wide mock or trust override. */
export async function writeFixtureReleaseLibrary(directory, selection = officialFixtureSelection) {
  await mkdir(path.join(directory, "build"), { recursive: true });
  await mkdir(path.join(directory, "generated"), { recursive: true });
  for (const name of ["package.json", "index.mjs", "release.json", "candidate.mjs", "derivative.mjs", "selection.mjs", "install.mjs", "build-policy.mjs", "build/recipe.json"]) {
    await copyFile(new URL(name, import.meta.url), path.join(directory, name));
  }
  if (selection.kind === "official") {
    // Both compiled fixture inputs intentionally declare the historical base.
    await writeFile(path.join(directory, "selection.json"), JSON.stringify(selection));
  } else {
    await copyFile(new URL("selection.json", import.meta.url), path.join(directory, "selection.json"));
    selection = { ...selection, build: selection.build ?? {
      schemaVersion: 1, mode: "development", sourcePolicySha256,
      recipeSha256: recipePolicySha256, sourceKey: "f".repeat(64),
    } };
  }
  await writeFile(path.join(directory, "generated", "selection.json"), JSON.stringify(selection));
  return directory;
}

/** Tiny non-executable artifacts exercise the real distribution verifier. */
export async function writeFixtureDerivativeDistribution(root) {
  const builds = [];
  for (const target of recipe.targets) {
    const directory = path.join(root, target); await mkdir(directory);
    const filename = target.startsWith("windows-") ? "opencode.exe" : "opencode";
    const binary = Buffer.from(`TEST FIXTURE ONLY ${target}`);
    const provenance = `${JSON.stringify({ ...recipe, target, officialBase: release.packages[target], sourceDateEpoch: "1770000000",
      compiler: { version: recipe.toolchain.bun, sha256: recipe.toolchain.executables["darwin-arm64"].sha256 },
      binary: { filename, sha256: sha(binary), signing: "test-fixture-only" } })}\n`;
    await writeFile(path.join(directory, filename), binary);
    await writeFile(path.join(directory, "provenance.json"), provenance);
    await writeFile(path.join(directory, "LICENSE"), "MIT test fixture");
    await writeFile(path.join(directory, "NOTICE"), "Not a real executable or distribution");
    await writeFile(path.join(directory, "SHA256SUMS"), `${sha(binary)}  ${filename}\n${sha(provenance)}  provenance.json\n`);
    builds.push({ target, directory, provenanceSha256: sha(provenance) });
  }
  const archives = path.join(root, "archives"), manifestPath = path.join(root, "derivative.json");
  const assembled = await assembleDerivativeDistribution({ builds, outputDirectory: archives, manifestPath, onProgress: () => {} });
  const manifestContent = await readFile(manifestPath, "utf8");
  return { builds, archives, manifestPath, manifest: JSON.parse(manifestContent), selection: {
    schemaVersion: 1, kind: "derivative", version: recipe.version, baseVersion: release.version,
    manifestContent, manifestSha256: assembled.manifestSha256,
  } };
}
