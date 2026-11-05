import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { opencodeRelease, opencodeReleaseTarget } from "@legalwork/opencode-release";
import { verifyOpencodeCandidate } from "@legalwork/opencode-release/candidate";

/** Explicit host capability for synthetic engines. It exercises production
 * hash/version checks without changing the selector or mocking native tests. */
export async function verifiedTestEngine(directory: string, source: (version: string) => string) {
  const recipe = JSON.parse(await readFile(new URL("../../../packages/opencode-release/build/recipe.json", import.meta.url), "utf8"));
  const target = opencodeReleaseTarget();
  const filename = process.platform === "win32" ? "opencode.exe" : "opencode";
  const bin = join(directory, filename), bytes = source(recipe.version);
  const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  await writeFile(bin, bytes); await chmod(bin, 0o755);
  const provenance = JSON.stringify({ ...recipe, target, officialBase: opencodeRelease.packages[target],
    compiler: { version: recipe.toolchain.bun, sha256: recipe.toolchain.executables["darwin-arm64"].sha256 },
    binary: { filename, sha256: sha(bytes) },
  });
  await writeFile(join(directory, "provenance.json"), provenance);
  return { bin, candidateBuild: await verifyOpencodeCandidate({ directory, provenanceSha256: sha(provenance) }), version: String(recipe.version) };
}
