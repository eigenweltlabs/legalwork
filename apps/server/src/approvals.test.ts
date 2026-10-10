import { describe, expect, test } from "bun:test";
import { ApprovalService } from "./approvals.js";
import type { ApprovalRequest } from "./types.js";

const input: Omit<ApprovalRequest, "id" | "createdAt"> = {
  workspaceId: "workspace",
  action: "skills.delete",
  summary: "Delete skill demo",
  paths: ["/workspace/.opencode/skills/demo"],
  actor: { type: "remote", clientId: "client", scope: "collaborator" },
};

describe("host approval handler", () => {
  test("ten chat approvals stay independent and never open the host dialog", async () => {
    let dialogs = 0, changes = 0;
    const service = new ApprovalService({ mode: "auto", timeoutMs: 1000 }, async () => { dialogs++; return "allow"; }, () => changes++);
    const commands = Array.from({ length: 10 }, (_, index) => service.requestApproval({ ...input, sessionID: `chat-${index}` }, undefined, true));
    await Promise.resolve();
    expect(dialogs).toBe(0);
    expect(service.list()).toHaveLength(10);
    const pending = service.list();
    for (const request of pending.slice().reverse()) service.respond(request.id, request.sessionID === "chat-3" ? "allow" : "deny");
    expect((await Promise.all(commands)).map((result) => result.allowed)).toEqual(Array.from({ length: 10 }, (_, index) => index === 3));
    expect(service.list()).toEqual([]);
    expect(changes).toBe(20);
    expect(service.respond(pending[3].id, "allow")).toBeNull();
  });
  test("a sandbox ask cannot be bypassed by automatic server approvals", async () => {
    let called = false;
    const service = new ApprovalService({ mode: "auto", timeoutMs: 1000 }, async () => {
      called = true;
      return "deny";
    });
    expect((await service.requestApproval(input, undefined, true)).allowed).toBe(false);
    expect(called).toBe(true);
  });
  test("auto does not present a confirmation", async () => {
    let called = false;
    const service = new ApprovalService({ mode: "auto", timeoutMs: 1000 }, async () => {
      called = true;
      return "deny";
    });
    expect((await service.requestApproval(input)).allowed).toBe(true);
    expect(called).toBe(false);
  });

  test("manual waits for the host and includes the requester and paths", async () => {
    const service = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, async (request) => {
      expect(request).toMatchObject(input);
      expect(service.list()).toEqual([request]);
      return "allow";
    });
    expect((await service.requestApproval(input)).allowed).toBe(true);
    expect(service.list()).toEqual([]);
  });

  test("denials and host errors never approve", async () => {
    const denied = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, async () => "deny");
    expect(await denied.requestApproval(input)).toMatchObject({ allowed: false, reason: "denied" });
    const failed = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, async () => { throw new Error("window closed"); });
    expect(await failed.requestApproval(input)).toMatchObject({ allowed: false, reason: "host_unavailable" });
  });

  test("timeout closes host confirmation and ignores its late allow", async () => {
    let finish: (reply: "allow" | "deny") => void = () => { throw new Error("no host prompt"); };
    let hostSignal: AbortSignal | undefined;
    const service = new ApprovalService({ mode: "manual", timeoutMs: 10 }, async (_request, signal) => {
      hostSignal = signal;
      return new Promise((resolve) => { finish = resolve; });
    });
    const result = await service.requestApproval(input);
    expect(result).toMatchObject({ allowed: false, reason: "timeout" });
    expect(hostSignal?.aborted).toBe(true);
    finish("allow");
    await Promise.resolve();
    expect(service.respond(result.id, "allow")).toBeNull();
  });

  test("host API response closes native confirmation", async () => {
    const service = new ApprovalService({ mode: "manual", timeoutMs: 1000 }, async (request, signal) => {
      service.respond(request.id, "deny");
      expect(signal.aborted).toBe(true);
      return "allow";
    });
    expect((await service.requestApproval(input)).allowed).toBe(false);
  });

  test("client cancellation and shutdown cancel pending confirmations", async () => {
    const service = new ApprovalService({ mode: "manual", timeoutMs: 1000 });
    const controller = new AbortController();
    const pending = service.requestApproval(input, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ allowed: false, reason: "cancelled" });
    const next = service.requestApproval(input);
    service.dispose();
    expect(await next).toMatchObject({ allowed: false, reason: "cancelled" });
    expect((await service.requestApproval(input)).allowed).toBe(false);
    expect(service.list()).toEqual([]);
  });
});
