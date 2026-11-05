import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareManagedGlobalLibrary } from "./managed-global-library.js";
import { orgPolicyEngineDir } from "./org-policy-engine.js";
import type { ServerConfig } from "./types.js";

async function fixture(run: (root: string, source: string, config: ServerConfig) => Promise<void>) {
  const scratch = join(import.meta.dir, "../../../.legalwork/scratch");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "managed-global-library-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "profile");
  const config: ServerConfig = {
    configPath: join(root, "server.json"), managedEngineStorageDirectory: join(root, "engine"),
    host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 0,
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  try { await run(root, join(root, "profile", "opencode"), config); }
  finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("shared packages keep original native files and never discover project or ancestor packages", () => fixture(async (root, source, config) => {
  const agent = "---\nmodel: custom/model#high\npermissions:\n  - action: read\n    resource: '**'\n    effect: ask\nrequest:\n  body:\n    reasoning: { effort: high }\n---\nOriginal agent instructions.\n";
  const command = "---\nagent: package/reviewer\nsubagent: true\nmodel: custom/model#high\n---\nReview $ARGUMENTS without changing the source.\n";
  await mkdir(join(source, "agents", "package"), { recursive: true });
  await mkdir(join(source, "commands", "package"), { recursive: true });
  await writeFile(join(source, "agents", "package", "reviewer.md"), agent);
  await writeFile(join(source, "commands", "package", "review.md"), command);
  await mkdir(join(root, ".opencode", "plugins", "ancestor-plugin"), { recursive: true });
  await writeFile(join(root, "opencode.json"), '{"plugins":["ancestor-plugin"]}');
  const result = await prepareManagedGlobalLibrary(config);
  const destination = orgPolicyEngineDir(config);
  expect(await readFile(join(destination, "agents", "package", "reviewer.md"), "utf8")).toBe(agent);
  expect(await readFile(join(destination, "commands", "package", "review.md"), "utf8")).toBe(command);
  expect(result.plugins).toEqual([]);
  expect((await lstat(join(destination, "agents"))).isSymbolicLink()).toBe(true);
  expect((await readdir(source)).sort()).toEqual(["agents", "commands"]);
  expect(await prepareManagedGlobalLibrary(config)).toEqual(result);
  expect(await readFile(join(source, "agents", "package", "reviewer.md"), "utf8")).toBe(agent);
}));

test("global plugin selections preserve native options, source-relative paths and linked discovery identities", () => fixture(async (_root, source, config) => {
  await mkdir(join(source, "plugins", "package"), { recursive: true });
  await mkdir(join(source, "plugin"), { recursive: true });
  await writeFile(join(source, "plugin", "legacy.js"), "export default {};");
  await writeFile(join(source, "plugins", "ignored.txt"), "not a plugin");
  await symlink(join(source, "plugins", "package"), join(source, "plugins", "linked-package"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(source, "plugin-target.txt"), "./selected-plugin\n");
  const json = '{"plugin":["legacy-package@1.2.3","{file:plugin-target.txt}"]}\n';
  const jsonc = '// Original global configuration\n{"plugins":[{"package":"./configured-plugin","options":{"nested":{"secret":"{file:setup/token.txt}","literal":true}}},"file://' + join(source, "url-plugin") + '","-opencode.config.command"],}\n';
  await writeFile(join(source, "opencode.json"), json);
  await writeFile(join(source, "opencode.jsonc"), jsonc);
  const result = await prepareManagedGlobalLibrary(config);
  const destination = orgPolicyEngineDir(config);
  expect(result.plugins).toEqual([
    join(destination, "plugin", "legacy.js"), join(destination, "plugins", "linked-package"), join(destination, "plugins", "package"),
    "legacy-package@1.2.3", join(source, "selected-plugin"),
    { package: join(source, "configured-plugin"), options: { nested: { secret: `{file:${join(source, "setup", "token.txt")}}`, literal: true } } },
    join(source, "url-plugin"), "-opencode.config.command",
  ]);
  expect(await readFile(join(source, "opencode.json"), "utf8")).toBe(json);
  expect(await readFile(join(source, "opencode.jsonc"), "utf8")).toBe(jsonc);
  expect((await lstat(join(destination, "plugins"))).isSymbolicLink()).toBe(true);
}));

test("preparing an empty shared library creates no profile paths and preserves protected-directory collisions", () => fixture(async (_root, source, config) => {
  await prepareManagedGlobalLibrary(config);
  expect(await lstat(source).then(() => true, () => false)).toBe(false);
  const agents = join(orgPolicyEngineDir(config), "agents");
  await rm(agents);
  await mkdir(agents);
  await writeFile(join(agents, "preserve.md"), "Keep this existing private file.\n");
  await expect(prepareManagedGlobalLibrary(config)).rejects.toThrow("already occupied");
  expect(await readFile(join(agents, "preserve.md"), "utf8")).toBe("Keep this existing private file.\n");
}));
