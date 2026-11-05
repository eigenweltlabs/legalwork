import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";

/** Real engine/package smoke, with isolated storage and no model inference. */
export async function checkOpencodeRuntime(binary, candidateBuild) {
  const expectedVersion = await expectedOpencodeVersion(binary, candidateBuild);
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-opencode-runtime-"));
  const plugin = path.join(root, "plugin"), workspace = path.join(root, "workspace");
  await Promise.all([plugin, workspace, ...["home", "config", "data", "cache", "state"].map(name => path.join(root, name))].map(directory => mkdir(directory, { recursive: true })));
  const skillPath = path.join(workspace, "runtime-check.md");
  await writeFile(skillPath, "# Runtime check\n");
  await writeFile(path.join(plugin, "index.mjs"), `import { Plugin } from "@opencode/plugin";
import { Effect } from "effect";
export default Plugin.define({id:"legalwork.runtime-check",async setup(ctx){
  await ctx.skill.transform(editor=>editor.add({id:"legalwork-runtime-check",name:"Runtime check",description:"No inference package check",path:${JSON.stringify(skillPath)},content:Effect.runSync(Effect.succeed("host-runtime-ok"))}));
}});
`);
  const password = randomBytes(32).toString("hex");
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...process.env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "data", "engine.db"), OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [plugin], update: "disable" }),
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.OPENCODE_SERVER_USERNAME;
  let output = "", spawnError;
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  child.on("error", error => { spawnError = error; });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  try {
    // This is a test deadline, not a model, output, context, or product limit.
    const deadline = Date.now() + 30_000;
    let url;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error("OpenCode exited before readiness");
      url = /^server listening on (https?:\/\/[^\s]+)/m.exec(output)?.[1];
      if (url) break;
      await delay(30);
    }
    if (!url) throw new Error("OpenCode did not announce its listener");
    const request = async pathname => {
      const response = await fetch(new URL(pathname, url), { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status}`);
      return response.json();
    };
    const unauthenticated = await fetch(new URL("/api/info", url), { signal: AbortSignal.timeout(10_000) });
    await unauthenticated.body?.cancel();
    if (unauthenticated.status !== 401) throw new Error("OpenCode accepted an unauthenticated API request");
    const info = await request("/api/info");
    if (info.version !== expectedVersion || info.pid !== child.pid) throw new Error("OpenCode info did not identify the pinned child process");
    let skill;
    while (Date.now() < deadline) {
      const skills = await request(`/api/skill?location[directory]=${encodeURIComponent(workspace)}`);
      skill = skills.data?.find(item => item.id === "legalwork-runtime-check");
      if (skill) break;
      await delay(50);
    }
    if (skill?.content !== "host-runtime-ok") throw new Error("Native directory plugin did not resolve the host's Plugin and Effect modules");
    return { version: info.version, authenticated: true, nativePlugin: true, paidCalls: 0 };
  } catch (cause) {
    throw new Error(`OpenCode packaged runtime check failed: ${cause.message}\n${output}`, { cause });
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, delay(3000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
}
