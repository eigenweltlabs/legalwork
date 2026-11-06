import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ApprovalService } from "./approvals.js";
import { openRememberedApprovalStore } from "./remembered-approvals.js";
import type { ApprovalRequest } from "./types.js";

const input = (workspaceId: string, sessionID = "first-chat"): Omit<ApprovalRequest, "id" | "createdAt"> => ({
  workspaceId, sessionID, actor: { type: "host" }, action: "sandbox.webfetch", summary: "Send this exact request", paths: [],
});

test("existing project approvals retain their scope without making new approvals project-wide", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-existing-project-approval-"));
  const store = await openRememberedApprovalStore({ configPath: join(root, "server.json") });
  const key = "existing-project-request";
  store.remember("project-a", createHash("sha256").update(JSON.stringify(["project-approval-v1", "project-a", key])).digest("hex"));
  const service = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, undefined, undefined, store);
  try {
    for (const chat of ["original-chat", "another-chat"])
      expect(await service.requestApproval(input("project-a", chat), undefined, true, key)).toMatchObject({ id: "remembered", allowed: true });
    const other = service.requestApproval(input("project-b", "another-chat"), undefined, true, key);
    service.respond(service.list()[0].id, "deny");
    expect((await other).allowed).toBe(false);
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("chat sandbox approvals survive restart and stay exact, chat scoped and revocable", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-remembered-approval-"));
  const config = { configPath: join(root, "server.json") };
  const key = "https://example.invalid/request Authorization: private-credential body: private-document";
  let service = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, undefined, undefined, await openRememberedApprovalStore(config));
  const approve = async (workspace: string, session: string, requestKey: string, reply: "always" | "allow" | "deny") => {
    const result = service.requestApproval(input(workspace, session), undefined, true, requestKey);
    const pending = service.list()[0];
    expect(pending).toBeDefined();
    service.respond(pending.id, reply);
    return result;
  };
  try {
    expect((await approve("project-a", "first-chat", key, "always")).allowed).toBe(true);
    expect((await approve("project-a", "first-chat", "once-request", "allow")).allowed).toBe(true);
    service.dispose();
    const bytes = await readFile(join(root, "remembered-approvals.sqlite"));
    expect(bytes.includes(Buffer.from("private-credential"))).toBe(false);
    expect(bytes.includes(Buffer.from("private-document"))).toBe(false);
    if (process.platform !== "win32") expect((await stat(join(root, "remembered-approvals.sqlite"))).mode & 0o777).toBe(0o600);
    service = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, undefined, undefined, await openRememberedApprovalStore(config));
    expect(await service.requestApproval(input("project-a", "first-chat"), undefined, true, key)).toMatchObject({ id: "remembered", allowed: true });
    expect((await approve("project-a", "new-chat", key, "deny")).allowed).toBe(false);
    expect((await approve("project-b", "first-chat", key, "deny")).allowed).toBe(false);
    expect((await approve("project-a", "new-chat", `${key} changed`, "deny")).allowed).toBe(false);
    expect((await approve("project-a", "new-chat", "once-request", "deny")).allowed).toBe(false);
    expect((await approve("project-b", "new-chat", "other-project-request", "always")).allowed).toBe(true);
    service.forgetRemembered("project-a");
    service.dispose();
    service = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, undefined, undefined, await openRememberedApprovalStore(config));
    expect((await approve("project-a", "new-chat", key, "deny")).allowed).toBe(false);
    expect(await service.requestApproval(input("project-b", "new-chat"), undefined, true, "other-project-request")).toMatchObject({ id: "remembered", allowed: true });
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("failed durable approval write refuses execution and leaves no remembered grant", async () => {
  const service = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, undefined, undefined, {
    has: () => false, remember: () => { throw new Error("Disk unavailable"); }, forget: () => {}, close: () => {},
  });
  try {
    const first = service.requestApproval(input("project-a"), undefined, true, "exact-request");
    expect(service.respond(service.list()[0].id, "always")).toMatchObject({ allowed: false, reason: "approval_storage_unavailable" });
    expect((await first).allowed).toBe(false);
    const again = service.requestApproval(input("project-a"), undefined, true, "exact-request");
    expect(service.list()).toHaveLength(1);
    service.respond(service.list()[0].id, "deny");
    expect((await again).allowed).toBe(false);
  } finally { service.dispose(); }
});

test("revocation by a second server connection invalidates a remembered grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-approval-revoke-"));
  const config = { configPath: join(root, "server.json") };
  const service = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, undefined, undefined, await openRememberedApprovalStore(config));
  const other = await openRememberedApprovalStore(config);
  try {
    const first = service.requestApproval(input("project-a"), undefined, true, "exact-request");
    service.respond(service.list()[0].id, "always");
    await first;
    other.forget("project-a");
    const after = service.requestApproval(input("project-a"), undefined, true, "exact-request");
    expect(service.list()).toHaveLength(1);
    service.respond(service.list()[0].id, "deny");
    expect((await after).allowed).toBe(false);
  } finally { other.close(); service.dispose(); await rm(root, { recursive: true, force: true }); }
});


test("a failed revocation refuses remembered access until its project erase succeeds", async () => {
  const records = new Map<string, Set<string>>();
  let failErase = false;
  const service = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, undefined, undefined, {
    has: (workspace, key) => records.get(workspace)?.has(key) === true,
    remember: (workspace, key) => { let values = records.get(workspace); if (!values) { values = new Set(); records.set(workspace, values); } values.add(key); },
    forget: workspace => { if (failErase) throw new Error("Storage unavailable"); if (workspace === undefined) records.clear(); else records.delete(workspace); },
    close: () => {},
  });
  try {
    for (const project of ["project-a", "project-b"]) {
      const first = service.requestApproval(input(project), undefined, true, "exact-request");
      service.respond(service.list()[0].id, "always"); await first;
    }
    failErase = true;
    expect(() => service.forgetRemembered("project-a")).toThrow("could not be revoked");
    expect(await service.requestApproval(input("project-a"), undefined, true, "exact-request")).toMatchObject({ allowed: false, reason: "approval_storage_unavailable" });
    expect(await service.requestApproval(input("project-b"), undefined, true, "exact-request")).toMatchObject({ id: "remembered", allowed: true });
    failErase = false;
    const next = service.requestApproval(input("project-a"), undefined, true, "exact-request");
    expect(service.list()).toHaveLength(1);
    service.respond(service.list()[0].id, "deny"); expect((await next).allowed).toBe(false);
  } finally { service.dispose(); }
});
