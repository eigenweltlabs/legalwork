import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";
import { createManagedOpencodeServer } from "./managed-opencode.js";

/** Characterizes an upstream boundary; this is not proof of sandbox parity. */
test.skipIf(!process.env.LEGALWORK_TEST_OPENCODE_BIN).each([false, true])("released worktree startup boundary and LegalWork product exclusion (protected=%s)", async protectedScope => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-worktree-start-")));
  const workspace = join(root, "source"), marker = join(root, "setup-ran"), shellMarker = join(root, "shell-hook");
  await Promise.all(["source", "plugin", "product", "home", "config", "data", "state", "cache"].map(name => mkdir(join(root, name), { recursive: true })));
  const env = { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (args: string[]) => {
    const process = Bun.spawn(["git", ...args], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (code !== 0) throw new Error(output + error);
  };
  let engine: Awaited<ReturnType<typeof createManagedOpencodeServer>> | undefined;
  try {
    await git(["init", "--initial-branch=main"]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@legalwork.invalid", "commit", "--allow-empty", "-m", "Fixture"]);
    await writeFile(join(root, "plugin", "index.js"), `import {Plugin} from '@opencode/plugin';import{writeFileSync}from'node:fs';let calls=0;export default Plugin.define({id:'legalwork.worktree-boundary',async setup(ctx){await ctx.shell.hook('create.before',()=>{writeFileSync(${JSON.stringify(shellMarker)},String(++calls));throw new Error('Fixture forbids native host shell')});}});`);
    if (protectedScope) {
      const result = Bun.spawn([process.execPath, "build", fileURLToPath(new URL("./opencode-plugins/legalwork-product-scope.ts", import.meta.url)), "--outfile", join(root, "product", "index.js"), "--target", "node", "--format", "esm", "--external", "@opencode/plugin", "--external", "@opencode/plugin/*"], { stdout: "pipe", stderr: "pipe" });
      const [code, output, error] = await Promise.all([result.exited, new Response(result.stdout).text(), new Response(result.stderr).text()]);
      if (code !== 0) throw new Error(output + error);
    }
    engine = await createManagedOpencodeServer({ bin: process.env.LEGALWORK_TEST_OPENCODE_BIN, cwd: workspace, timeoutMs: 30_000, env: { ...env,
      OPENCODE_CONFIG_DIR: join(root, "config"), OPENCODE_DB: join(root, "engine.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false, plugins: [join(root, "plugin"), ...(protectedScope ? [join(root, "product")] : [])] }),
    } });
    const client = OpenCode.make({ baseUrl: engine.url, headers: { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } });
    const location = { directory: workspace };
    await client.model.list({ location });
    await expect(client.shell.create({ location, command: "true" })).rejects.toThrow();
    expect(await readFile(shellMarker, "utf8")).toBe("1");
    const project = (await client.location.get({ location })).project;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const source = "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ",process.cwd())";
    await client.project.update({ projectID: project.id, commands: { start: quote(process.execPath) + " -e " + quote(source) } });
    const input = { projectID: project.id, from: workspace, directory: join(root, "copies"), name: "parallel" };
    if (protectedScope) {
      await expect(client.worktree.create(input)).rejects.toThrow();
      expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    } else {
      const created = await client.worktree.create(input);
      expect(created.directory).not.toBe(workspace);
      expect(await realpath(await readFile(marker, "utf8"))).toBe(await realpath(created.directory));
    }
    expect(await readFile(shellMarker, "utf8")).toBe("1");
  } finally { await engine?.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
