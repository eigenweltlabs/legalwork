import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { opencodeReleaseTarget } from "@legalwork/opencode-release";
import { writeFixtureDerivativeDistribution, writeFixtureReleaseLibrary } from "../../../packages/opencode-release/test-fixture.mjs";

async function fixture(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "legalwork-server-engine-bundle-")));
  try {
    const distributionRoot = path.join(root, "distribution"); await mkdir(distributionRoot);
    const distribution = await writeFixtureDerivativeDistribution(distributionRoot);
    const library = await writeFixtureReleaseLibrary(path.join(root, "node_modules/@legalwork/opencode-release"), distribution.selection);
    const { installSelectedEngineForHost } = await import(pathToFileURL(path.join(library, "install.mjs")).href);
    const executable = path.join(root, "runtime/legalwork-server");
    const installed = await installSelectedEngineForHost({ installRoot: path.join(root, "runtime/opencode-engine"),
      archiveDirectory: distribution.archives, cacheDirectory: path.join(root, "cache"), target: opencodeReleaseTarget() });
    const helper = path.join(root, "server-opencode-executable.ts");
    await copyFile(new URL("./server-opencode-executable.ts", import.meta.url), helper);
    const { resolveServerOpencodeExecutable } = await import(pathToFileURL(helper).href);
    await run({ root, binary: installed.path, executable, resolve: resolveServerOpencodeExecutable });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("standalone startup uses its adjacent exactly pinned artifact", () => fixture(async ({ binary, executable, resolve }) => {
  expect(await resolve(undefined, executable)).toBe(binary);
}));

test("an explicit verified binary wins without changing bundle selection", () => fixture(async ({ root, binary, resolve }) => {
  expect(await resolve(binary, path.join(root, "missing/legalwork-server"))).toBe(binary);
  if (process.platform !== "win32") {
    const alias = path.join(root, "explicit-engine-link"); await symlink(binary, alias);
    expect(await resolve(alias)).toBe(alias);
  }
}));

test("missing or changed bundled engines never fall back to a PATH executable", () => fixture(async ({ root, binary, executable, resolve }) => {
  await expect(resolve(undefined, path.join(root, "missing/legalwork-server"))).rejects.toThrow("missing or changed");
  await writeFile(binary, "changed bundle bytes");
  await expect(resolve(undefined, executable)).rejects.toThrow("missing or changed");
  await expect(resolve(binary, executable)).rejects.toThrow("missing or changed");
}));
