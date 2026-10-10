import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSandboxService } from "./service.js";
import { webInputSchema } from "./web.js";
import { brokerRequest, type OutboundRequest, type OutboundResponse, prepareOutboundRequest } from "./network.js";
import type { SandboxRun } from "./vm.js";
import { readSandboxNetworkMode, writeSandboxNetworkMode, writeSandboxDefault, writeSessionSandbox, effectiveSandbox } from "./settings.js";
import { ApprovalService } from "../approvals.js";
import { resetOrgPolicyRuntimeForTests } from "../org-policy.js";
import { closeRuntimeOpencodeConfig, GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ApprovalRequest, ServerConfig, WorkspaceInfo } from "../types.js";

const roots: string[] = [];
const configs: ServerConfig[] = [];
afterEach(async () => {
  for (const config of configs.splice(0)) {
    await closeRuntimeOpencodeConfig(config);
    await resetOrgPolicyRuntimeForTests(config);
  }
  // Other shared stores may retain prepared statements until GC on Windows.
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
  await writeSandboxDefault(config, { enabled: true, networkMode: "approve" });
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

test("approval identifies non-printable payloads instead of showing invisible text", async () => {
  const f = await fixture({ webfetch: "allow" }, true, async (input) => {
    await input.authorizeNetwork(prepareOutboundRequest({ url: "https://example.com/", method: "POST", headers: {}, bodyBase64: "AAEC" }));
  });
  await f.run();
  expect(f.prompts[0].network).toMatchObject({ body: "AAEC", bodyFormat: "base64", bodyBytes: 3 });
  expect(f.prompts[0].summary).toContain("Base64: AAEC");
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
      const changed = new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      void writeSandboxNetworkMode(f.config, "block");
      await changed;
      expect(input.signal.aborted).toBe(true);
      input.signal.throwIfAborted();
      return { output: "", exitCode: 0, truncated: false };
    },
  });
  await expect(service.run(f.workspace, { command: "python3 report.py", write: false, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal)).rejects.toThrow("Sandbox settings changed");
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

test("application off and per-chat on run side by side, with all network modes and parent inheritance", async () => {
  const f = await fixture({ "*": "allow" });
  await writeSandboxDefault(f.config, { enabled: false, networkMode: "block" });
  const run = (sessionID: string, lineage = [sessionID]) => f.service.run(f.workspace,
    { command: "echo host-proof", sessionID, write: false, timeoutMs: 10000 }, { type: "host" }, new AbortController().signal, [], lineage);
  const host = await run("ordinary");
  expect(host).toMatchObject({ exitCode: 0, sandbox: "host" });
  expect(host.output).toContain("host-proof");
  expect(f.executions).toHaveLength(0);
  for (const networkMode of ["allow", "block", "approve"] satisfies Array<"allow" | "block" | "approve">) {
    await writeSessionSandbox(f.config, f.workspace.id, "protected", { enabled: true, networkMode });
    expect((await run("protected")).sandbox).toBe("virtual-machine");
    expect(f.executions.at(-1)?.networkMode).toBe(networkMode);
    expect((await run("child", ["child", "protected"])).sandbox).toBe("virtual-machine");
  }
  await writeSandboxDefault(f.config, { enabled: true, networkMode: "allow" });
  await writeSessionSandbox(f.config, f.workspace.id, "ordinary", { enabled: false, networkMode: "block" });
  expect((await run("ordinary")).sandbox).toBe("host");
  await writeSessionSandbox(f.config, f.workspace.id, "ordinary", null);
  expect((await run("ordinary")).sandbox).toBe("virtual-machine");
  await closeRuntimeOpencodeConfig(f.config);
  expect(await effectiveSandbox(f.config, f.workspace.id, ["protected"])).toMatchObject({ enabled: true, networkMode: "approve", source: "session" });
});

test("ten chats retain independent overrides and only affected commands are cancelled", async () => {
  const running = new Map<string, AbortSignal>();
  const f = await fixture({ "*": "allow" }, true, async input => {
    running.set(input.command, input.signal);
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    input.signal.throwIfAborted();
  });
  const commands = Array.from({ length: 10 }, (_, i) => f.service.run(f.workspace,
    { command: `command-${i}`, sessionID: `chat-${i}`, write: false, timeoutMs: 10000 }, { type: "host" }, new AbortController().signal).catch(error => error));
  while (running.size < 10) await Bun.sleep(1);
  await writeSessionSandbox(f.config, f.workspace.id, "chat-1", { enabled: false, networkMode: "approve" });
  expect(running.get("command-1")?.aborted).toBe(true);
  expect([...running.values()].filter(signal => signal.aborted)).toHaveLength(1);
  // An explicit override is independent of application-wide changes.
  await writeSessionSandbox(f.config, f.workspace.id, "chat-10", { enabled: true, networkMode: "block" });
  const extra = f.service.run(f.workspace, { command: "override", sessionID: "chat-10", write: false, timeoutMs: 10000 }, { type: "host" }, new AbortController().signal).catch(error => error);
  while (!running.has("override")) await Bun.sleep(1);
  await writeSandboxDefault(f.config, { enabled: false, networkMode: "approve" });
  expect(running.get("override")?.aborted).toBe(false);
  expect([...running.values()].filter(signal => signal.aborted)).toHaveLength(10);
  f.service.stop();
  await Promise.all([...commands, extra]);
});

test("unprotected commands still respect shell, read and write denials", async () => {
  for (const tool of ["bash", "read", "edit", "webfetch"]) {
    const f = await fixture({ [tool]: "deny" });
    await writeSandboxDefault(f.config, { enabled: false, networkMode: "allow" });
    await expect(f.service.run(f.workspace, { command: "echo must-not-run", write: false, timeoutMs: 1000 }, { type: "host" }, new AbortController().signal)).rejects.toThrow();
    expect(f.executions).toHaveLength(0);
  }
});

const webInput = (url = "https://wttr.in/Berlin?format=j1") => webInputSchema.parse({ kind: "fetch", url, format: "text", sessionID: "weather", agent: "build" });
const waitForWebApproval = async (service: AgentSandboxService, count = 1) => {
  for (let i = 0; i < 500; i++) {
    if (service.approvals.list().length === count) return service.approvals.list();
    await Bun.sleep(2);
  }
  throw new Error("Missing web approval");
};
function observedWebNetwork(responses: OutboundResponse[] = [{ status: 200, headers: {}, bodyBase64: Buffer.from("Weather").toString("base64") }]) {
  const resolved: string[] = [], sent: OutboundRequest[] = [];
  const send: typeof brokerRequest = (request, authorize, signal, _, options) => brokerRequest(request, authorize, signal, {
    resolve: async host => { resolved.push(host); return [{ address: "93.184.216.34", family: 4 }]; },
    send: async request => { sent.push(request); return responses[Math.min(sent.length - 1, responses.length - 1)]; },
  }, options);
  return { send, resolved, sent };
}

test("weather page waits for inline approval before DNS or sending, even with automatic tool approvals", async () => {
  const f = await fixture({ webfetch: "allow" });
  const net = observedWebNetwork();
  const result = f.service.web(f.workspace, webInput(), { type: "host" }, new AbortController().signal, [], undefined, net.send);
  const [approval] = await waitForWebApproval(f.service);
  expect(approval).toMatchObject({ sessionID: "weather", action: "sandbox.webfetch", network: { url: "https://wttr.in/Berlin?format=j1", method: "GET", bodyBytes: 0 } });
  expect(net.resolved).toEqual([]);
  expect(net.sent).toEqual([]);
  expect(f.prompts).toEqual([]); // No separate host modal.
  f.service.approvals.respond(approval.id, "allow");
  expect((await result).output).toBe("Weather");
  expect(net.resolved).toEqual(["wttr.in"]);
  expect(net.sent).toHaveLength(1);
});

test("declining a web read or blocking networking sends nothing", async () => {
  for (const mode of ["approve", "block"] satisfies Array<"approve" | "block">) {
    const f = await fixture({ webfetch: "allow" });
    await writeSandboxNetworkMode(f.config, mode);
    const net = observedWebNetwork();
    const result = f.service.web(f.workspace, webInput(), { type: "host" }, new AbortController().signal, [], undefined, net.send).catch(error => error);
    if (mode === "approve") {
      const [approval] = await waitForWebApproval(f.service);
      f.service.approvals.respond(approval.id, "deny");
    }
    expect(await result).toBeInstanceOf(Error);
    expect(net.resolved).toEqual([]);
    expect(net.sent).toEqual([]);
  }
});

test("web allow and sandbox-off skip network prompts but retain explicit permissions", async () => {
  for (const enabled of [true, false]) {
    const f = await fixture({ webfetch: "allow" });
    await writeSandboxDefault(f.config, { enabled, networkMode: enabled ? "allow" : "block" });
    const net = observedWebNetwork();
    await f.service.web(f.workspace, webInput(), { type: "host" }, new AbortController().signal, [], undefined, net.send);
    expect(net.sent).toHaveLength(1);
    expect(f.service.approvals.list()).toEqual([]);
    await writeRuntimeOpencodeConfig(f.config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permission: { webfetch: "deny" } }));
    await expect(f.service.web(f.workspace, webInput(), { type: "host" }, new AbortController().signal, [], undefined, net.send)).rejects.toThrow("blocked by your permissions");
    expect(net.sent).toHaveLength(1);
  }
});

test("website redirects require a fresh exact approval and cannot inherit consent", async () => {
  const f = await fixture({ webfetch: "allow" });
  const net = observedWebNetwork([{ status: 302, headers: { location: "https://other.example/private?data=canary" }, bodyBase64: "" }]);
  const result = f.service.web(f.workspace, webInput(), { type: "host" }, new AbortController().signal, [], undefined, net.send).catch(error => error);
  const [first] = await waitForWebApproval(f.service);
  f.service.approvals.respond(first.id, "allow");
  const [second] = await waitForWebApproval(f.service);
  expect(second.network?.url).toBe("https://other.example/private?data=canary");
  expect(second.id).not.toBe(first.id);
  expect(net.sent).toHaveLength(1);
  f.service.approvals.respond(second.id, "deny");
  expect(await result).toBeInstanceOf(Error);
  expect(net.sent).toHaveLength(1);
});

test("approve web reads reject local-network redirects", async () => {
  const f = await fixture({ webfetch: "allow" });
  const net = observedWebNetwork([{ status: 302, headers: { location: "http://127.0.0.1/admin" }, bodyBase64: "" }]);
  const result = f.service.web(f.workspace, webInput(), { type: "host" }, new AbortController().signal, [], undefined, net.send).catch(error => error);
  const [approval] = await waitForWebApproval(f.service);
  f.service.approvals.respond(approval.id, "allow");
  expect(String(await result)).toContain("private network");
  expect(net.sent).toHaveLength(1);
});

test("changing chat network settings cancels a pending web read", async () => {
  const f = await fixture({ webfetch: "allow" });
  const net = observedWebNetwork();
  const result = f.service.web(f.workspace, webInput(), { type: "host" }, new AbortController().signal, [], undefined, net.send).catch(error => error);
  await waitForWebApproval(f.service);
  await writeSessionSandbox(f.config, f.workspace.id, "weather", { enabled: true, networkMode: "block" });
  expect(await result).toBeInstanceOf(Error);
  expect(f.service.approvals.list()).toEqual([]);
  expect(net.resolved).toEqual([]);
});

test("ten web reads have independent approvals and honor cancellation", async () => {
  const f = await fixture({ webfetch: "allow" });
  const net = observedWebNetwork();
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const reads = controllers.map((controller, i) => f.service.web(f.workspace, { ...webInput(), sessionID: `chat-${i}` }, { type: "host" }, controller.signal, [], undefined, net.send).catch(error => error));
  const approvals = await waitForWebApproval(f.service, 10);
  expect(net.sent).toEqual([]);
  controllers[0].abort();
  for (const approval of approvals.filter(item => item.sessionID !== "chat-0")) f.service.approvals.respond(approval.id, approval.sessionID === "chat-1" ? "allow" : "deny");
  const results = await Promise.all(reads);
  expect(results.filter(value => value instanceof Error)).toHaveLength(9);
  expect(net.sent).toHaveLength(1);
  expect(f.service.approvals.list()).toEqual([]);
});

test("web search waits before sending the exact query to its provider", async () => {
  const f = await fixture({ webfetch: "allow", websearch: "allow" });
  const net = observedWebNetwork([{ status: 200, headers: {}, bodyBase64: Buffer.from(JSON.stringify({ result: { content: [{ type: "text", text: "Berlin weather" }] } })).toString("base64") }]);
  const input = webInputSchema.parse({ kind: "search", query: "weather Berlin", sessionID: "weather", agent: "build" });
  const result = f.service.web(f.workspace, input, { type: "host" }, new AbortController().signal, [], undefined, net.send);
  const [approval] = await waitForWebApproval(f.service);
  expect(approval.description).toBe("Search the web for: weather Berlin");
  expect(approval.network?.url).toBe("https://mcp.exa.ai/mcp");
  expect(approval.network?.body).toContain('"query":"weather Berlin"');
  expect(net.resolved).toEqual([]);
  f.service.approvals.respond(approval.id, "allow");
  expect((await result).output).toBe("Berlin weather");
  expect(net.sent).toHaveLength(1);
});

test("web requests inherit parent settings and stricter agent permissions", async () => {
  const f = await fixture({ webfetch: "allow" });
  await writeSandboxDefault(f.config, { enabled: false, networkMode: "allow" });
  await writeSessionSandbox(f.config, f.workspace.id, "parent", { enabled: true, networkMode: "block" });
  const net = observedWebNetwork();
  await expect(f.service.web(f.workspace, webInput(), { type: "host" }, new AbortController().signal, [], ["weather", "parent"], net.send)).rejects.toThrow("blocked");
  await expect(f.service.web(f.workspace, webInput(), { type: "host" }, new AbortController().signal,
    [{ permission: "webfetch", pattern: "https://wttr.in/*", action: "deny" }], undefined, net.send)).rejects.toThrow("blocked");
  expect(net.sent).toEqual([]);
});

test("changing network mode closes an active web response", async () => {
  const f = await fixture({ webfetch: "allow" });
  await writeSandboxNetworkMode(f.config, "allow");
  let connected: () => void = () => {};
  const connection = new Promise<void>(resolve => { connected = resolve; });
  const server = Bun.serve({ port: 0, fetch: () => {
    connected();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial response")); } }));
  } });
  try {
    const result = f.service.web(f.workspace, webInput(server.url.href), { type: "host" }, AbortSignal.timeout(5000)).catch(error => error);
    await connection;
    await writeSandboxNetworkMode(f.config, "block");
    expect(await result).toBeInstanceOf(Error);
  } finally { server.stop(true); }
});
