import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSandboxService } from "./service.js";
import { prepareOutboundRequest } from "./network.js";
import type { SandboxRun } from "./vm.js";
import { readSandboxNetworkMode, writeSandboxNetworkMode } from "./settings.js";
import { ApprovalService } from "../approvals.js";
import { closeRuntimeOpencodeConfig, GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ApprovalRequest, ServerConfig, WorkspaceInfo } from "../types.js";

const roots: string[] = [];
const configs: ServerConfig[] = [];
afterEach(async () => {
  for (const config of configs.splice(0)) await closeRuntimeOpencodeConfig(config);
  // Bun's uncached Drizzle statements retain Windows file handles until GC,
  // even after sqlite3_close_v2 has marked the connection closed.
  for (const root of roots.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      Bun.gc(true);
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 5 || !(error instanceof Error) || !("code" in error) || error.code !== "EBUSY") throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

async function fixture(permissions: Record<string, unknown>, approve = true, onRun?: (input: SandboxRun) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-sandbox-policy-"));
  roots.push(root);
  const matter = join(root, "matter");
  await mkdir(matter);
  const workspace: WorkspaceInfo = { id: "ws_test", name: "Matter", path: matter, preset: "starter", workspaceType: "local" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "test-host", configPath: join(root, "private", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [matter],
    readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  configs.push(config);
  await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: permissions }));
  const prompts: ApprovalRequest[] = [];
  const approvals = new ApprovalService(config.approval, async (request) => { prompts.push(request); return approve ? "allow" : "deny"; });
  const executions: SandboxRun[] = [];
  const service = new AgentSandboxService(config, approvals, {
    status: async () => ({ available: true }), prepare: async () => "test-image",
    run: async (input) => { executions.push(input); await onRun?.(input); return { output: "done", exitCode: 0, truncated: false }; },
  });
  const run = (write = false) => service.run(workspace, { command: "python report.py", write, timeoutMs: 1000 },
    { type: "remote", scope: "collaborator" }, new AbortController().signal);
  return { config, workspace, service, prompts, executions, run };
}

test("shell denial prevents runtime launch", async () => {
  const fixtureState = await fixture({ bash: "deny" });
  await expect(fixtureState.run()).rejects.toThrow("bash is blocked");
  expect(fixtureState.executions).toHaveLength(0);
  expect(fixtureState.prompts).toHaveLength(0);
});

const networkRequest = () => prepareOutboundRequest({ url: "https://example.com/", method: "POST", headers: {}, bodyBase64: Buffer.from("test body").toString("base64") });

test("approve is the persistent default and prompts even when webfetch and server approvals allow", async () => {
  const f = await fixture({ webfetch: "allow" }, true, async (input) => {
    expect(input.networkMode).toBe("approve");
    expect(await input.authorizeNetwork(networkRequest())).toBe(true);
  });
  expect(await readSandboxNetworkMode(f.config)).toBe("approve");
  await f.run();
  expect(f.prompts.map((prompt) => prompt.action)).toEqual(["sandbox.webfetch"]);
  expect(f.prompts[0].summary).toContain("test body");
  expect(f.prompts[0].network).toMatchObject({ url: "https://example.com/", method: "POST", body: "test body", bodyFormat: "text", bodyBytes: 9 });
  await writeSandboxNetworkMode(f.config, "block");
  await closeRuntimeOpencodeConfig(f.config);
  expect(await readSandboxNetworkMode(f.config)).toBe("block");
});

test("block denies without an approval and allow sends without an approval", async () => {
  for (const mode of ["block", "allow"] satisfies Array<"block" | "allow">) {
    const f = await fixture({ webfetch: "allow" }, true, async (input) => {
      expect(input.networkMode).toBe(mode);
      if (mode === "block") await expect(input.authorizeNetwork(networkRequest())).rejects.toThrow("All sandbox network traffic is blocked");
      else expect(await input.authorizeNetwork(networkRequest())).toBe(true);
    });
    await writeSandboxNetworkMode(f.config, mode);
    await f.run();
    expect(f.prompts).toHaveLength(0);
  }
});

test("network approval denial blocks the request", async () => {
  const f = await fixture({ webfetch: "allow" }, false, async (input) => {
    await expect(input.authorizeNetwork(networkRequest())).rejects.toThrow("declined");
  });
  await f.run();
  expect(f.prompts).toHaveLength(1);
});

test("allow never bypasses scoped tool or agent restrictions with a direct NIC", async () => {
  const cases = [
    { permissions: { webfetch: { "*": "allow", "https://example.com/*": "deny" } }, rules: [] },
    { permissions: { webfetch: "allow" }, rules: [{ permission: "webfetch", pattern: "https://example.com/*", action: "deny" }] },
  ] satisfies Array<{ permissions: Record<string, unknown>; rules: Array<{ permission: string; pattern: string; action: "deny" }> }>;
  for (const entry of cases) {
    const f = await fixture(entry.permissions, true, async (input) => {
      expect(input.networkMode).toBe("approve");
      await expect(input.authorizeNetwork(networkRequest())).rejects.toThrow("webfetch is blocked");
    });
    await writeSandboxNetworkMode(f.config, "allow");
    await f.service.run(f.workspace, { command: "python3 report.py", write: false, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal, entry.rules);
    expect(f.prompts).toHaveLength(0);
  }
});

test("changing network mode cancels running commands and pending approvals", async () => {
  const f = await fixture({ webfetch: "allow" });
  await writeSandboxNetworkMode(f.config, "allow");
  const service = new AgentSandboxService(f.config, new ApprovalService(f.config.approval), {
    status: async () => ({ available: true }), prepare: async () => "test-image",
    run: async (input) => {
      expect(input.networkMode).toBe("allow");
      await writeSandboxNetworkMode(f.config, "block");
      expect(input.signal.aborted).toBe(true);
      input.signal.throwIfAborted();
      return { output: "", exitCode: 0, truncated: false };
    },
  });
  await expect(service.run(f.workspace, { command: "python3 report.py", write: false, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal)).rejects.toThrow("Permissions changed");
});

test("saving a network mode waits for cancelled workers to finish cleanup", async () => {
  const f = await fixture({ webfetch: "allow" });
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let release: () => void = () => {};
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  let sawAbort = false, saved = false;
  const service = new AgentSandboxService(f.config, new ApprovalService(f.config.approval), {
    status: async () => ({ available: true }), prepare: async () => "test-image",
    run: async (input) => {
      const cancelled = new Promise<void>((resolve) => input.signal.addEventListener("abort", () => { sawAbort = true; resolve(); }, { once: true }));
      ready(); await cancelled; await cleanup;
      input.signal.throwIfAborted();
      return { output: "", exitCode: 0, truncated: false };
    },
  });
  const command = service.run(f.workspace, { command: "sleep 100", write: false, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal).catch((error: unknown) => error);
  await started;
  const change = service.setNetworkMode("block").then(() => { saved = true; });
  while (!sawAbort) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(saved).toBe(false);
  release(); await change;
  expect(await command).toBeInstanceOf(Error);
  expect(saved).toBe(true);
});

test("installed helpers require skill permission and always enter read-only", async () => {
  const f = await fixture({ bash: "allow", read: "ask", skill: { "helper": "ask" } });
  const folder = join(f.workspace.path, ".opencode", "skills", "helper");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), "---\nname: helper\ndescription: Test installed helper\n---\nRun helper.py.\n");
  const command = { command: "python3 /skills/0/helper.py", skills: ["helper"], write: true, timeoutMs: 1000 };
  await f.service.run(f.workspace, command, { type: "host" }, new AbortController().signal);
  expect(f.executions[0].mounts[1]).toMatchObject({ target: "/skills/0", writable: false });
  expect(f.prompts.map((prompt) => prompt.action)).toEqual(["sandbox.skill", "sandbox.read"]);
  expect(f.prompts[1].paths).toContain(folder);
  await expect(f.service.run(f.workspace, command, { type: "host" }, new AbortController().signal,
    [{ permission: "skill", pattern: "helper", action: "deny" }])).rejects.toThrow("skill is blocked");
  expect(f.executions).toHaveLength(1);
});

test("read-only commands work when file changes are denied", async () => {
  const fixtureState = await fixture({ bash: "allow", edit: "deny" });
  await fixtureState.run();
  expect(fixtureState.executions[0].mounts[0].writable).toBe(false);
  await expect(fixtureState.run(true)).rejects.toThrow("edit is blocked");
  expect(fixtureState.executions).toHaveLength(1);
});

test("shell and file-change asks use real prompts even when the server auto-approves other operations", async () => {
  const fixtureState = await fixture({ bash: "ask", edit: "ask" });
  await fixtureState.run(true);
  expect(fixtureState.prompts.map((prompt) => prompt.action)).toEqual(["sandbox.bash", "sandbox.edit"]);
  expect(fixtureState.executions[0].mounts[0].writable).toBe(true);
});

test("a declined file-change prompt does not launch a writable sandbox", async () => {
  const fixtureState = await fixture({ bash: "allow", edit: "ask" }, false);
  await expect(fixtureState.run(true)).rejects.toThrow("declined");
  expect(fixtureState.executions).toHaveLength(0);
});

test("agent denials cannot be overridden by global allow settings", async () => {
  const fixtureState = await fixture({ bash: "allow", edit: "allow" });
  await expect(fixtureState.service.run(fixtureState.workspace,
    { command: "python report.py", write: true, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal,
    [{ permission: "*", pattern: "*", action: "allow" }, { permission: "edit", pattern: "*", action: "deny" }],
  )).rejects.toThrow("edit is blocked");
  expect(fixtureState.executions).toHaveLength(0);
});

test("later whole-tool permissions replace scoped engine defaults", async () => {
  const f = await fixture({ bash: "allow", read: "allow" });
  await f.service.run(f.workspace, { command: "python3 report.py", write: false, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal,
    [{ permission: "read", pattern: "*.env", action: "ask" }, { permission: "read", pattern: "*", action: "allow" }]);
  expect(f.prompts).toHaveLength(0);
  expect(f.executions).toHaveLength(1);
});

test("a scoped edit denial cannot be bypassed with a writable folder mount", async () => {
  const fixtureState = await fixture({ edit: { "*": "allow", "*.secret": "deny" } });
  await expect(fixtureState.run(true)).rejects.toThrow("edit is blocked");
});

test("a script cannot bypass scoped read or nested shell denials", async () => {
  const reads = await fixture({ read: { "*": "allow", "*.secret": "deny" } });
  await expect(reads.run()).rejects.toThrow("read is blocked");
  const shell = await fixture({ bash: { "*": "allow", "curl *": "deny" } });
  await expect(shell.run()).rejects.toThrow("bash is blocked");
  expect(reads.executions).toHaveLength(0);
  expect(shell.executions).toHaveLength(0);
});

test("changing permission settings aborts a running command before more network requests", async () => {
  const fixtureState = await fixture({ bash: "allow", webfetch: "allow" });
  let stopped = false;
  const service = new AgentSandboxService(fixtureState.config, new ApprovalService(fixtureState.config.approval), {
    status: async () => ({ available: true }), prepare: async () => "test-image",
    run: async (input) => {
      await writeRuntimeOpencodeConfig(fixtureState.config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { webfetch: "deny" } }));
      stopped = input.signal.aborted;
      await input.authorizeNetwork(prepareOutboundRequest({ url: "https://example.com/", method: "GET", headers: {}, bodyBase64: "" }));
      return { output: "", exitCode: 0, truncated: false };
    },
  });
  await expect(service.run(fixtureState.workspace, { command: "python script.py", write: false, timeoutMs: 1000 },
    { type: "host" }, new AbortController().signal)).rejects.toThrow("Permissions changed");
  expect(stopped).toBe(true);
});

test("an agent external-folder denial overrides an older workspace grant", async () => {
  const f = await fixture({ bash: "allow", read: "allow" });
  const external = await mkdtemp(join(tmpdir(), "sandbox-external-")); roots.push(external);
  await writeRuntimeOpencodeConfig(f.config, f.workspace.id, () => ({ permission: { external_directory: { [`${external}/*`]: "allow" } } }));
  await expect(f.service.run(f.workspace, { command: "python report.py", write: false, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal,
    [{ permission: "external_directory", pattern: "*", action: "deny" }])).rejects.toThrow("external_directory is blocked");
  expect(f.executions).toHaveLength(0);
});

test("a denied subfolder cannot enter a whole-folder snapshot", async () => {
  const f = await fixture({ bash: "allow", read: "allow" });
  const external = await mkdtemp(join(tmpdir(), "sandbox-external-")); roots.push(external);
  await writeRuntimeOpencodeConfig(f.config, f.workspace.id, () => ({ permission: { external_directory: { [`${external}/*`]: "allow", [`${external}/private/*`]: "deny" } } }));
  await expect(f.run()).rejects.toThrow("scoped folder denial");
  expect(f.executions).toHaveLength(0);
});

test("multiple authorized folders participate in read and edit approval", async () => {
  const f = await fixture({ bash: "allow", read: "ask", edit: "ask" });
  const sources = [join(f.workspace.path, "first"), join(f.workspace.path, "second")];
  for (const source of sources) await mkdir(source);
  await writeRuntimeOpencodeConfig(f.config, f.workspace.id, () => ({ permission: {
    external_directory: Object.fromEntries(sources.map((source) => [`${source}/*`, "allow"])),
  } }));
  await f.run(true);
  expect(f.executions[0].mounts.map(({ target, writable }) => ({ target, writable }))).toEqual([
    { target: "/workspace", writable: true },
    { target: "/authorized/0", writable: true },
    { target: "/authorized/1", writable: true },
  ]);
  expect(f.prompts.map(({ action, paths }) => ({ action, paths }))).toEqual([
    { action: "sandbox.read", paths: [f.workspace.path, ...sources] },
    { action: "sandbox.edit", paths: [f.workspace.path, ...sources] },
  ]);
});

test("an allowed parent cannot bypass a subfolder's approval requirement", async () => {
  for (const approved of [false, true]) {
    const f = await fixture({ bash: "allow", read: "allow" }, approved);
    const external = await mkdtemp(join(tmpdir(), "sandbox-external-")); roots.push(external);
    await writeRuntimeOpencodeConfig(f.config, f.workspace.id, () => ({ permission: { external_directory: {
      [`${external}/*`]: "allow", [`${external}/private/*`]: "ask",
    } } }));
    if (approved) await f.run();
    else await expect(f.run()).rejects.toThrow("declined");
    expect(f.prompts.map(({ action, paths }) => ({ action, paths }))).toEqual([
      { action: "sandbox.external_directory", paths: [external] },
    ]);
    expect(f.executions).toHaveLength(approved ? 1 : 0);
  }
});

test("removing a folder grant cancels commands using the previous folder snapshot", async () => {
  const f = await fixture({ bash: "allow", read: "allow" });
  const external = await mkdtemp(join(tmpdir(), "sandbox-external-")); roots.push(external);
  await writeRuntimeOpencodeConfig(f.config, f.workspace.id, () => ({ permission: { external_directory: { [`${external}/*`]: "allow" } } }));
  const service = new AgentSandboxService(f.config, new ApprovalService(f.config.approval), {
    status: async () => ({ available: true }), prepare: async () => "test-image",
    run: async (input) => {
      expect(input.mounts).toHaveLength(2);
      await writeRuntimeOpencodeConfig(f.config, f.workspace.id, () => ({ permission: { external_directory: {} } }));
      expect(input.signal.aborted).toBe(true);
      input.signal.throwIfAborted();
      return { output: "", exitCode: 0, truncated: false };
    },
  });
  await expect(service.run(f.workspace, { command: "python report.py", write: false, timeoutMs: 1000 },
    { type: "host" }, new AbortController().signal)).rejects.toThrow("Permissions changed");
  await f.run();
  expect(f.executions[0].mounts).toHaveLength(1);
});
