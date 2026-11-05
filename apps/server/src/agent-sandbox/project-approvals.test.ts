import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalService } from "../approvals.js";
import { openRememberedApprovalStore } from "../remembered-approvals.js";
import { closeRuntimeOpencodeConfig, GLOBAL_TOOL_PERMISSIONS_ID, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { resetOrgPolicyRuntimeForTests } from "../org-policy.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import type { RawHttpInput, RawHttpNetwork } from "./raw-http.js";
import { AgentSandboxService } from "./service.js";
import { writeSandboxDefault } from "./settings.js";

test("sandbox requests remember the exact operation for one chat across restart and native settings migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-project-approval-"));
  const projects: WorkspaceInfo[] = ["a", "b"].map(name => ({ id: `ws_${name}`, name, path: join(root, name), preset: "starter", workspaceType: "local" }));
  await Promise.all(projects.map(project => mkdir(project.path)));
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "test-host", configPath: join(root, "private", "server.json"),
    approval: { mode: "auto", timeoutMs: 3000 }, corsOrigins: [], workspaces: projects, authorizedRoots: projects.map(project => project.path),
    readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  let connected = 0;
  const network: RawHttpNetwork = {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    send: async () => { connected++; return { status: 200, statusText: "OK", headers: {}, bodyBase64: "" }; },
  };
  const backend = { status: async () => ({ available: true }), prepare: async () => "unused", run: async () => { throw new Error("No shell expected"); } };
  const create = async () => new AgentSandboxService(config,
    new ApprovalService(config.approval, undefined, undefined, await openRememberedApprovalStore(config)), backend);
  let service = await create();
  const input: RawHttpInput & { sessionID: string } = { sessionID: "first-chat", url: "https://example.com/request", method: "POST", headers: { authorization: "private-test-value" }, bodyBase64: Buffer.from("document").toString("base64") };
  const run = (project = projects[0], request = input) => service.rawHttp(project, request, { type: "host" }, new AbortController().signal, [], undefined, network);
  const pending = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const request = service.approvals.list()[0];
      if (request) return request;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Expected a project permission request");
  };
  try {
    await writeSandboxDefault(config, { enabled: true, networkMode: "approve" });
    await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, () => ({ permissions: [{ action: "webfetch", resource: "*", effect: "allow" }] }));
    const first = run();
    const approval = await pending();
    expect(connected).toBe(0);
    expect(approval.canRemember).toBe(true);
    service.approvals.respond(approval.id, "always");
    await first;
    await run();
    expect(connected).toBe(2);
    await service.stop();
    service.approvals.dispose();
    await closeRuntimeOpencodeConfig(config);
    service = await create();
    await run();
    expect(connected).toBe(3);
    await writeRuntimeOpencodeConfig(config, projects[0].id, current => ({ ...current, agents: { reviewer: { description: "Unrelated agent edit" } } }));
    await run();
    expect(connected).toBe(4);
    for (const [project, request] of [[projects[1], input], [projects[0], { ...input, sessionID: "other-chat" }], [projects[0], { ...input, bodyBase64: Buffer.from("changed document").toString("base64") }]] satisfies Array<[WorkspaceInfo, typeof input]>) {
      const denied = run(project, request).catch(error => error);
      const next = await pending();
      service.approvals.respond(next.id, "deny");
      expect(await denied).toBeInstanceOf(Error);
      expect(connected).toBe(4);
    }
    await writeRuntimeOpencodeConfig(config, projects[0].id, current => ({ ...current, permissions: [{ action: "webfetch", resource: "*", effect: "deny" }] }));
    await expect(run()).rejects.toThrow("blocked by your permissions");
    expect(service.approvals.list()).toEqual([]);
    expect(connected).toBe(4);
    await writeRuntimeOpencodeConfig(config, projects[0].id, current => ({ ...current, permissions: [] }));
    const revoked = run().catch(error => error);
    service.approvals.respond((await pending()).id, "deny");
    expect(await revoked).toBeInstanceOf(Error);
    expect(connected).toBe(4);
  } finally {
    await service.stop();
    service.approvals.dispose();
    await closeRuntimeOpencodeConfig(config);
    await resetOrgPolicyRuntimeForTests(config);
    await rm(root, { recursive: true, force: true });
  }
});

test("failed durable revocation still aborts an active sandbox and refuses stale grants until storage recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-revocation-failure-"));
  const workspace: WorkspaceInfo = { id: "matter", name: "Matter", path: join(root, "matter"), preset: "starter", workspaceType: "local" };
  await mkdir(workspace.path);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "private", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [workspace.path],
    readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
  };
  const records = new Map<string, Set<string>>();
  let failErase = false, activeSignal: AbortSignal | undefined;
  let started = () => {};
  const active = new Promise<void>(resolve => { started = resolve; });
  const approvals = new ApprovalService(config.approval, undefined, undefined, {
    has: (id, key) => records.get(id)?.has(key) === true,
    remember: (id, key) => { const values = records.get(id) ?? new Set(); values.add(key); records.set(id, values); },
    forget: id => { if (failErase) throw new Error("Approval storage unavailable"); if (id === undefined) records.clear(); else records.delete(id); },
    close: () => {},
  });
  const service = new AgentSandboxService(config, approvals, {
    status: async () => ({ available: true }), prepare: async () => "unused",
    run: async input => {
      activeSignal = input.signal; started();
      await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { output: "", exitCode: 0, truncated: false };
    },
  });
  const request = { workspaceId: workspace.id, sessionID: "previous-chat", actor: { type: "host" }, action: "sandbox.webfetch", summary: "Exact request", paths: [] } satisfies Omit<import("../types.js").ApprovalRequest, "id" | "createdAt">;
  let operation: Promise<unknown> | undefined;
  try {
    await writeSandboxDefault(config, { enabled: true, networkMode: "block" });
    await writeRuntimeOpencodeConfig(config, workspace.id, () => ({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }));
    const saved = approvals.requestApproval(request, undefined, true, "exact operation");
    approvals.respond(approvals.list()[0].id, "always"); expect((await saved).allowed).toBe(true);
    operation = service.run(workspace, { command: "echo fixture", write: false, timeoutMs: 1000, sessionID: "running-chat" }, { type: "host" }, new AbortController().signal).catch(error => error);
    await Promise.race([active, operation.then(() => { throw new Error("The sandbox stopped before its revocation check."); })]);
    failErase = true;
    await expect(writeRuntimeOpencodeConfig(config, workspace.id, () => ({ permissions: [{ action: "shell", resource: "*", effect: "deny" }] }))).rejects.toMatchObject({ status: 503, code: "approval_storage_unavailable" });
    expect(activeSignal?.aborted).toBe(true);
    await operation;
    expect(await approvals.requestApproval({ ...request, sessionID: "next-chat" }, undefined, true, "exact operation"))
      .toMatchObject({ allowed: false, reason: "approval_storage_unavailable" });
    failErase = false;
    const recovered = approvals.requestApproval({ ...request, sessionID: "after-recovery" }, undefined, true, "exact operation");
    expect(approvals.list()).toHaveLength(1);
    approvals.respond(approvals.list()[0].id, "deny"); expect((await recovered).allowed).toBe(false);
  } finally {
    failErase = false; await service.stop(); await operation; approvals.dispose();
    await closeRuntimeOpencodeConfig(config); await resetOrgPolicyRuntimeForTests(config); await rm(root, { recursive: true, force: true });
  }
});
