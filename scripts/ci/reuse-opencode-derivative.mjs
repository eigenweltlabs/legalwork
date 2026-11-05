// Manual CI reuse supplies bytes from a named same-repository Actions run.
// The independent manifest pin and current reviewed recipe still supply trust.
import { appendFile, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertBuildReady, verifyInputs } from "../../packages/opencode-release/build/candidate.mjs";
import { derivativeFileSha256, verifyDerivativeDistribution } from "../../packages/opencode-release/derivative.mjs";
import recipe from "../../packages/opencode-release/build/recipe.json" with { type: "json" };

export function derivativeReuseInputs(runID = "", manifestSha256 = "") {
  if (runID === "" && manifestSha256 === "") return false;
  if (!/^[1-9][0-9]*$/.test(runID) || !/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error("Reuse requires the original producer run ID and its independent manifest SHA256 together.");
  }
  return true;
}

export async function verifyReusedDerivative(directory, manifestSha256) {
  await verifyInputs(recipe); assertBuildReady(recipe);
  const root = path.resolve(directory), manifestPath = path.join(root, "derivative-release.json");
  if (!(await lstat(root)).isDirectory() || !(await lstat(manifestPath)).isFile()) throw new Error("The reused distribution and manifest must be ordinary paths.");
  const verified = await verifyDerivativeDistribution({ manifestPath, manifestSha256 });
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isDeepStrictEqual(manifest.upstream, recipe.upstream)) throw new Error("The reused manifest upstream identity differs from the current recipe.");
  const archives = path.join(root, "archives");
  if (!(await lstat(archives)).isDirectory()) throw new Error("Reused archives must be an ordinary directory.");
  const pins = Object.entries(manifest.artifacts).map(([target, artifact]) => ({ target, ...artifact.archive }));
  if (JSON.stringify((await readdir(archives)).sort()) !== JSON.stringify(pins.map(pin => pin.filename).sort())) throw new Error("The reused distribution must contain exactly the twelve pinned archives.");
  for (const pin of pins) {
    const archive = path.join(archives, pin.filename), metadata = await lstat(archive);
    if (!metadata.isFile() || metadata.size !== pin.size || await derivativeFileSha256(archive) !== pin.sha256) throw new Error(`Reused archive integrity differs: ${pin.target}`);
  }
  // Retain the independent identity after all large archive reads too.
  await verifyDerivativeDistribution({ manifestPath, manifestSha256 });
  return { manifestSha256, version: verified.version, targets: pins.length, archives: pins };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "inputs") {
    const reuse = derivativeReuseInputs(process.env.REUSE_RUN_ID, process.env.REUSE_MANIFEST_SHA256);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `reuse=${reuse}\n`);
    console.log(reuse ? "Explicit producer reuse selected; all archives still require verification." : "Compile the current reviewed engine recipe.");
  } else if (process.argv[2] === "verify") {
    const [, , , directory, manifestSha256] = process.argv;
    derivativeReuseInputs(process.env.REUSE_RUN_ID, manifestSha256);
    if (!directory) throw new Error("A downloaded distribution directory is required.");
    const result = await verifyReusedDerivative(directory, manifestSha256);
    await writeFile(path.join(directory, "..", "reuse-receipt.json"), `${JSON.stringify({ ...result, producerRunID: process.env.REUSE_RUN_ID }, null, 2)}\n`, { flag: "wx" });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `manifest-sha256=${result.manifestSha256}\n`);
    console.log(`Verified all ${result.targets} unchanged engine archives against ${result.manifestSha256}.`);
  } else throw new Error("Use inputs or verify <downloaded-distribution-directory> <independent-manifest-sha256>.");
}
