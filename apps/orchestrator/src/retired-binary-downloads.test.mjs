import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertNoRetiredBinaryDownloads } from "./retired-binary-downloads.ts";
import { writeFixtureReleaseLibrary, writeFixtureDerivativeDistribution } from "../../../packages/opencode-release/test-fixture.mjs";

async function fixture(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "legalwork-binary-download-retirement-")));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const childEnv = root => ({ PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data") });
async function execute(entry, args, env, runtimeArguments = []) {
  const child = Bun.spawn([process.execPath, ...runtimeArguments, entry, ...args], { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
async function write(root, name, value) {
  const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value); return file;
}

test("retired explicit URLs/source modes reject without exposing their values", () => {
  for (const flags of [new Map([["sidecar-base-url", "fixture-sensitive-value"]]), new Map([["sidecar-manifest", "fixture-sensitive-value"]]),
    new Map([["sidecar-source", "downloaded"]]), new Map([["opencode-source", "downloaded"]])]) {
    expect(() => assertNoRetiredBinaryDownloads(flags, {})).toThrow("Standalone binary downloads are retired");
    try { assertNoRetiredBinaryDownloads(flags, {}); } catch (error) { expect(error.message).not.toContain("fixture-sensitive-value"); }
  }
  for (const name of ["LEGALWORK_SIDECAR_BASE_URL", "LEGALWORK_SIDECAR_MANIFEST_URL", "LEGALWORK_ORCHESTRATOR_DOWNLOAD_BASE_URL"])
    expect(() => assertNoRetiredBinaryDownloads(new Map(), { [name]: "fixture-sensitive-value" })).toThrow("retired");
  for (const name of ["LEGALWORK_SIDECAR_SOURCE", "LEGALWORK_OPENCODE_SOURCE"])
    expect(() => assertNoRetiredBinaryDownloads(new Map(), { [name]: "downloaded" })).toThrow("retired");
});

test("local bundled/external preferences and unrelated connection fields remain valid", () => {
  for (const mode of ["auto", "bundled", "external"]) {
    expect(() => assertNoRetiredBinaryDownloads(new Map([["sidecar-source", mode], ["opencode-source", mode], ["legalwork-url", "http://127.0.0.1"], ["legalwork-token", "fixture-only"]]), {})).not.toThrow();
  }
  expect(() => assertNoRetiredBinaryDownloads(new Map([["sidecar-source", "external"]]), { LEGALWORK_SIDECAR_SOURCE: "downloaded" })).not.toThrow();
});

async function cliFixture(root) {
  const source = path.join(root, "src"); await mkdir(source);
  for (const name of ["cli.ts", "legacy-developer-launcher.ts", "retired-messaging-tools.ts", "retired-binary-downloads.ts"])
    await copyFile(new URL(name, import.meta.url), path.join(source, name));
  await writeFixtureReleaseLibrary(path.join(root, "node_modules/@legalwork/opencode-release"));
  await mkdir(path.join(root, "node_modules/@opencode"), { recursive: true });
  await symlink(await realpath(new URL("../node_modules/@opencode/client", import.meta.url)), path.join(root, "node_modules/@opencode/client"), process.platform === "win32" ? "junction" : "dir");
  return path.join(source, "cli.ts");
}

test("the actual CLI rejects retired input before runtime/profile work and never calls the URL", () => fixture(async root => {
  const entry = await cliFixture(root);
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("must not fetch"); } });
  try {
    for (const args of [["start", "--sidecar-base-url", `http://127.0.0.1:${server.port}`], ["serve", "--opencode-source", "downloaded"]]) {
      const result = await execute(entry, [...args, "--data-dir", path.join(root, "runtime")], childEnv(root));
      expect(result.code, result.stderr).toBe(1); expect(result.stderr).toContain("Standalone binary downloads are retired");
      expect(await readdir(root)).not.toContain("runtime");
    }
    expect(requests).toBe(0);
    const help = await execute(entry, ["--help"], childEnv(root));
    expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain("legalwork start");
    expect(help.stdout).not.toContain("--sidecar-base-url"); expect(help.stdout).not.toContain("auto | bundled | downloaded");
  } finally { await server.stop(true); }
}));

test("the actual CLI retains authenticated manual host-token API connections", () => fixture(async root => {
  const entry = await cliFixture(root); let authorized = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    authorized = request.headers.get("X-LegalWork-Host-Token") === "fixture-only-host-token";
    return Response.json(authorized ? [] : { error: "unauthorized" }, { status: authorized ? 200 : 401 });
  } });
  try {
    const result = await execute(entry, ["approvals", "list", "--legalwork-url", `http://127.0.0.1:${server.port}`, "--host-token", "fixture-only-host-token"], childEnv(root));
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual([]); expect(authorized).toBe(true);
  } finally { await server.stop(true); }
}));

test("postinstall uses an installed npm platform package and never fetches a fallback", () => fixture(async root => {
  const entry = await write(root, "postinstall.mjs", await readFile(new URL("../scripts/postinstall.mjs", import.meta.url), "utf8"));
  const forbidFetch = await write(root, "forbid-fetch.mjs", "console.error('FETCH_GUARD_INSTALLED');globalThis.fetch=()=>{throw Error('NETWORK_MUST_NOT_RUN')};");
  const missing = await execute(entry, [], { ...childEnv(root), LEGALWORK_ORCHESTRATOR_DOWNLOAD_BASE_URL: "http://127.0.0.1:1" }, ["--preload", forbidFetch]);
  expect(missing.code).toBe(1); expect(missing.stderr).toContain("FETCH_GUARD_INSTALLED"); expect(missing.stderr).toContain("Enable optionalDependencies"); expect(missing.stderr).not.toContain("NETWORK_MUST_NOT_RUN");
  const platform = process.platform === "win32" ? "windows" : process.platform;
  await write(root, `node_modules/legalwork-orchestrator-${platform}-${process.arch}/package.json`, '{"name":"fixture-only"}');
  const installed = await execute(entry, [], childEnv(root));
  expect(installed.code, installed.stderr).toBe(0); expect(installed.stdout).toContain("installed platform package");
}));


test("npm platform preparation retains CLI, matching server manifest and all five engine files without publishing", () => fixture(async root => {
  const distributionRoot = path.join(root, "distribution"); await mkdir(distributionRoot);
  const distribution = await writeFixtureDerivativeDistribution(distributionRoot);
  const library = await writeFixtureReleaseLibrary(path.join(root, "node_modules/@legalwork/opencode-release"), distribution.selection);
  const { installSelectedEngineForHost } = await import(pathToFileURL(path.join(library, "install.mjs")).href);
  const orchestrator = path.join(root, "apps/orchestrator");
  await write(root, "apps/orchestrator/package.json", '{"version":"1.2.3"}');
  await write(root, "apps/server/package.json", '{"version":"4.5.6"}');
  await write(root, "constants.json", '{}');
  await write(root, "apps/orchestrator/bin/legalwork", '// fixture-only CLI wrapper');
  await write(root, "apps/orchestrator/scripts/postinstall.mjs", await readFile(new URL("../scripts/postinstall.mjs", import.meta.url), "utf8"));
  const source = await write(root, "apps/orchestrator/scripts/publish-npm.mjs", await readFile(new URL("../scripts/publish-npm.mjs", import.meta.url), "utf8"));
  const platforms = [["darwin-arm64", "bun-darwin-arm64", "darwin-arm64"], ["darwin-x64", "bun-darwin-x64", "darwin-x64-baseline"],
    ["linux-x64", "bun-linux-x64", "linux-x64-baseline"], ["linux-arm64", "bun-linux-arm64", "linux-arm64"], ["windows-x64", "bun-windows-x64", "windows-x64-baseline"]];
  for (const [id, bun, target] of platforms) {
    const ext = id.startsWith("windows-") ? ".exe" : "";
    await write(root, `apps/orchestrator/dist/bin/legalwork-${bun}${ext}`, `fixture CLI ${id}`);
    await write(root, `apps/orchestrator/dist/sidecars/legalwork-server-${id}${ext}`, `fixture server ${id}`);
    await installSelectedEngineForHost({ installRoot: path.join(orchestrator, "dist/bin/opencode-engine"),
      archiveDirectory: distribution.archives, cacheDirectory: path.join(root, "cache"), target });
  }
  const driver = await write(root, "prepare-only.mjs", `const {prepareNpmPackages}=await import(${JSON.stringify(pathToFileURL(source).href)});console.log(JSON.stringify(await prepareNpmPackages()));`);
  // Even a regression of the publisher's main guard cannot reach npm or a
  // registry from this child: no PATH tools or inherited credentials exist.
  const prepared = await execute(driver, [], { ...childEnv(root), PATH: "", NPM_CONFIG_REGISTRY: "http://127.0.0.1:1" });
  expect(prepared.code, prepared.stderr).toBe(0);
  const packages = JSON.parse(prepared.stdout);
  expect(packages.length).toBe(6);
  for (const [id, , target] of platforms) {
    const ext = id.startsWith("windows-") ? ".exe" : "";
    const directory = path.join(orchestrator, `dist/npm/legalwork-orchestrator-${id}`);
    expect(await readFile(path.join(directory, `bin/legalwork-server${ext}`), "utf8")).toBe(`fixture server ${id}`);
    const manifest = JSON.parse(await readFile(path.join(directory, "bin/versions.json"), "utf8"));
    expect(manifest["legalwork-server"].version).toBe("4.5.6");
    expect(manifest["legalwork-server"].sha256).toBe(new Bun.CryptoHasher("sha256").update(`fixture server ${id}`).digest("hex"));
    const engine = path.join(directory, "bin/opencode-engine", distribution.selection.manifestSha256, target);
    expect((await readdir(engine)).sort()).toEqual(["LICENSE", "NOTICE", "SHA256SUMS", "provenance.json", `opencode${ext}`].sort());
    expect(JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")).files).toEqual(["bin"]);
  }
}));
