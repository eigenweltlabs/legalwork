import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { opencodeReleaseTarget } from "@legalwork/opencode-release";
import { opencodeEngineSelection, verifySelectedOpencodeEngine } from "@legalwork/opencode-release/selection";

/** Host startup resolves only an explicit verified path or the fixed bundle.
 * Source/dev wrappers supply their verified artifact path before CLI import. */
export async function resolveServerOpencodeExecutable(explicit: string | undefined, executable = process.execPath): Promise<string> {
  const binary = explicit?.trim() || join(dirname(executable), "opencode-engine", opencodeEngineSelection.artifactId,
    opencodeReleaseTarget(), process.platform === "win32" ? "opencode.exe" : "opencode");
  try {
    if (!(await stat(binary)).isFile()) throw new Error("The selected engine is not a regular file.");
    await verifySelectedOpencodeEngine(binary);
    return binary;
  } catch (cause) {
    throw new Error("The selected OpenCode engine is missing or changed. Rebuild the standalone bundle, or use the normal prepared development entrypoint.", { cause });
  }
}
