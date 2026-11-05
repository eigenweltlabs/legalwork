import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveServerConfig } from "./config.js";
import { prepareManagedOpencodeDependencies } from "./managed-opencode-dependencies.js";

const roots: string[] = [];
const previous = process.env.LEGALWORK_RUNTIME_DB;
afterEach(async () => {
  if (previous === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previous;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup(version = "2.1.4") {
  const root = await mkdtemp(join(tmpdir(), "managed-host-")); roots.push(root);
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config = await resolveServerConfig({ configPath: join(root, "server.json"), workspaces: [] });
  config.agentSandboxEnabled = true;
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  await writeFile(join(bundle, "package.json"), JSON.stringify({ opencode: { version, runtime: "released-cli", providedModules: ["@opencode/plugin", "effect"] } }));
  return { config, bundle, root, directory: join(root, "engine-home", "config", "opencode") };
}

test("a declared native host needs no installed SDK and does not create a dependency tree", async () => {
  const { config, bundle, directory } = await setup();
  for (let iteration = 0; iteration < 2; iteration++) {
    expect(await prepareManagedOpencodeDependencies(config, bundle)).toEqual({ seeded: false, reason: "host-provided", version: "2.1.4", retired: [] });
    expect(await lstat(directory).catch(() => null)).toBeNull();
    expect(await lstat(join(bundle, "node_modules")).catch(() => null)).toBeNull();
  }
});

test("old managed SDK is retired without touching a linked source or custom packages", async () => {
  const { config, bundle, directory, root } = await setup();
  const legacy = "@opencode-ai/plugin", source = join(root, "old-sdk"), target = join(directory, "node_modules", legacy);
  await mkdir(source);
  await writeFile(join(source, "keep"), "linked source remains available for rollback");
  await mkdir(join(directory, "node_modules", "@opencode-ai"), { recursive: true });
  await mkdir(join(directory, "node_modules", "custom"));
  await writeFile(join(directory, "node_modules", "custom", "keep"), "unchanged");
  await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "kept", dependencies: { [legacy]: `file:${source}`, custom: "2.0.0" }, scripts: { kept: "true" } }));
  await writeFile(join(directory, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { [legacy]: `file:${source}`, custom: "2.0.0" } }, [`node_modules/${legacy}`]: { link: true }, "node_modules/custom": { version: "2.0.0" } } }));
  expect((await prepareManagedOpencodeDependencies(config, bundle)).retired).toEqual([directory]);
  expect(await lstat(target).catch(() => null)).toBeNull();
  expect(await readFile(join(source, "keep"), "utf8")).toContain("rollback");
  expect(await readFile(join(directory, "node_modules", "custom", "keep"), "utf8")).toBe("unchanged");
  expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8"))).toEqual({ name: "kept", dependencies: { custom: "2.0.0" }, scripts: { kept: "true" } });
  expect(JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"))).toEqual({ lockfileVersion: 3, packages: { "": { dependencies: { custom: "2.0.0" } }, "node_modules/custom": { version: "2.0.0" } } });
  expect((await prepareManagedOpencodeDependencies(config, bundle)).retired).toEqual([]);
});

test("wrong/missing runtime declarations fail before mutating configuration", async () => {
  const { config, bundle, directory, root } = await setup("2.1.3");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), "broken");
  await expect(prepareManagedOpencodeDependencies(config, bundle)).rejects.toThrow("must match released engine 2.1.4");
  expect(await readFile(join(directory, "package.json"), "utf8")).toBe("broken");
  await expect(prepareManagedOpencodeDependencies(config, join(root, "missing"))).rejects.toThrow("runtime declaration is missing");
  config.agentSandboxEnabled = false;
  expect(await prepareManagedOpencodeDependencies(config, bundle)).toEqual({ seeded: false, reason: "unmanaged" });
});

test("malformed files or a foreign directory cannot be silently replaced", async () => {
  const { config, bundle, directory } = await setup();
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), "broken");
  await expect(prepareManagedOpencodeDependencies(config, bundle)).rejects.toThrow();
  expect(await readFile(join(directory, "package.json"), "utf8")).toBe("broken");
  await writeFile(join(directory, "package.json"), JSON.stringify({ dependencies: { "@opencode-ai/plugin": "1.18.29" } }));
  const target = join(directory, "node_modules", "@opencode-ai/plugin");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "package.json"), JSON.stringify({ name: "foreign-data" }));
  await expect(prepareManagedOpencodeDependencies(config, bundle)).rejects.toThrow("unknown managed dependency");
  expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8"))).toHaveProperty("dependencies.@opencode-ai/plugin", "1.18.29");
});
