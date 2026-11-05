import { appendFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectedOpencodeVersion } from "./candidate.mjs";
import { opencodeReleaseTarget } from "./index.mjs";
import { installSelectedOpencodeEngine, opencodeEngineSelection } from "./selection.mjs";

/** Locations supply bytes, never identity. The build-owned selection supplies
 * the manifest and independent pin, including for unpublished offline builds. */
export async function installSelectedEngineForHost({ installRoot, cacheDirectory, archiveDirectory, target = opencodeReleaseTarget(), fetcher }) {
  const installed = await installSelectedOpencodeEngine({
    directory: path.join(path.resolve(installRoot), opencodeEngineSelection.artifactId, target),
    cacheDirectory: path.resolve(cacheDirectory), archiveDirectory, target, fetcher,
  });
  await expectedOpencodeVersion(installed.path, installed.candidateBuild);
  return { kind: opencodeEngineSelection.kind, path: installed.path, version: installed.version, baseVersion: installed.baseVersion, target };
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const installRoot = value("--install-root"), cacheDirectory = value("--cache-directory");
  if (!installRoot || !cacheDirectory) throw new Error("Usage: install.mjs --install-root <directory> --cache-directory <directory> [--archive-directory <reviewed-local-archives>] [--target <target>] [--github-actions]");
  let installed;
  try {
    installed = await installSelectedEngineForHost({ installRoot, cacheDirectory,
      archiveDirectory: value("--archive-directory") || process.env.LEGALWORK_OPENCODE_ARCHIVES,
      target: value("--target"),
    });
  } catch (cause) {
    throw new Error(`Cannot install selected OpenCode ${opencodeEngineSelection.version}. Unpublished derivatives require their exact reviewed local archives or verified cache; only a download URL compiled into the selector may supply network bytes. ${cause.message}`, { cause });
  }
  if (args.includes("--github-actions")) {
    if (!process.env.GITHUB_PATH || !process.env.GITHUB_ENV) throw new Error("GitHub Actions PATH and environment files are required.");
    const directory = path.dirname(installed.path), cache = path.resolve(cacheDirectory);
    if ([directory, installed.path, cache].some(value => /[\r\n]/.test(value))) throw new Error("GitHub Actions engine paths must not contain newlines.");
    await appendFile(process.env.GITHUB_PATH, `${directory}\n`);
    await appendFile(process.env.GITHUB_ENV, `LEGALWORK_TEST_OPENCODE_BIN=${installed.path}\nLEGALWORK_TEST_OPENCODE_CACHE=${cache}\n`);
  }
  console.log(JSON.stringify(installed));
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main();
