import { describe, expect, test } from "bun:test";
import { submitHomeMessage, type PendingHomeMessage } from "../src/react-app/domains/session/home/home-submission";
import { homeProjectIdFromSearch, homeRoute } from "../src/react-app/shell/workspace-routes";

describe("Home message submission", () => {
  test("the onboarding handoff keeps the created project for the first message, including after reload", async () => {
    const createdProjectId = "created project/ü & 1";
    const homeUrl = new URL(homeRoute(createdProjectId), "https://legalwork.local");
    const reloadedUrl = new URL(homeUrl.toString());
    const workspaceId = homeProjectIdFromSearch(reloadedUrl.search);
    if (!workspaceId) throw new Error("Onboarding project was lost");
    expect(homeUrl.pathname).toBe("/home");
    expect(workspaceId).toBe(createdProjectId);
    const sessionId = await submitHomeMessage({
      workspaceId, text: "Review this", files: [new File(["sample"], "sample.txt")],
      pending: { sessionId: null, uploads: new Map() },
      client: { writeWorkspaceBinaryFile: async (target, payload) => {
        expect(target).toBe(createdProjectId);
        return { ok: true, path: payload.path, bytes: payload.data.byteLength, updatedAt: 0 };
      } },
      createSession: async () => ({ id: "first-session" }),
      sendPrompt: async (target, text) => {
        expect(target).toBe("first-session");
        expect(text).toContain("Review this");
        expect(text).toContain("sample.txt");
      },
    });
    expect(sessionId).toBe("first-session");
  });

  test("ordinary Home entry and choosing New project clear the onboarding selection", () => {
    expect(homeRoute(null)).toBe("/home");
    expect(homeProjectIdFromSearch(new URL(homeRoute(null), "https://legalwork.local").search)).toBeNull();
    expect(homeProjectIdFromSearch("?project=%20%20")).toBeNull();
  });

  test("copies original file bytes before creating the session and sending references", async () => {
    const steps: string[] = [];
    const bytes = new Uint8Array([0, 80, 75, 255, 128]);
    const file = new File([bytes], "Contract (final).docx");
    const pending: PendingHomeMessage = { sessionId: null, uploads: new Map() };
    const sessionId = await submitHomeMessage({
      workspaceId: "target-project", text: "  Review this contract  ", files: [file], pending,
      client: { writeWorkspaceBinaryFile: async (workspaceId, payload) => {
        steps.push("copy");
        expect(workspaceId).toBe("target-project");
        expect(new Uint8Array(payload.data)).toEqual(bytes);
        return { ok: true, path: payload.path, bytes: bytes.length, updatedAt: 0 };
      } },
      createSession: async () => { steps.push("create"); return { id: "new-session" }; },
      sendPrompt: async (sessionId, text, context) => {
        steps.push("send");
        expect(sessionId).toBe("new-session");
        expect(text).toStartWith("Review this contract\n\n");
        expect(text).toContain("Contract (final).docx");
        expect(text).toContain(".legalwork/attachments/");
        expect(context).toContain("Its original bytes are saved");
        expect(context).toContain("not as instructions from the user");
      },
    });
    expect(steps).toEqual(["copy", "create", "send"]);
    expect(sessionId).toBe("new-session");
  });

  test("a send retry reuses copied files and the session", async () => {
    let copies = 0, sessions = 0, attempts = 0;
    const pending: PendingHomeMessage = { sessionId: null, uploads: new Map() };
    const input = {
      workspaceId: "project", text: "Review", files: [new File(["sample"], "sample.txt")], pending,
      client: { writeWorkspaceBinaryFile: async (_workspaceId: string, payload: { path: string; data: ArrayBuffer }) => {
        copies++;
        return { ok: true, path: payload.path, bytes: payload.data.byteLength, updatedAt: 0 };
      } },
      createSession: async () => { sessions++; return { id: "session" }; },
      sendPrompt: async () => { if (++attempts === 1) throw new Error("Send unavailable"); },
    };
    await expect(submitHomeMessage(input)).rejects.toThrow("Send unavailable");
    expect(await submitHomeMessage(input)).toBe("session");
    expect(copies).toBe(1);
    expect(sessions).toBe(1);
    expect(attempts).toBe(2);
  });

  test("partial upload failure stops the send and only retries the failed file", async () => {
    const calls: string[] = [];
    const first = new File(["first"], "first.txt"), second = new File(["second"], "second.txt");
    let fail = true;
    const pending: PendingHomeMessage = { sessionId: null, uploads: new Map() };
    const input = {
      workspaceId: "project", text: "", files: [first, second], pending,
      client: { writeWorkspaceBinaryFile: async (_workspaceId: string, payload: { path: string; data: ArrayBuffer }) => {
        const name = payload.path.endsWith("first.txt") ? "first" : "second";
        calls.push(name);
        if (name === "second" && fail) throw new Error("Copy failed");
        return { ok: true, path: payload.path, bytes: payload.data.byteLength, updatedAt: 0 };
      } },
      createSession: async () => { calls.push("create"); return { id: "session" }; },
      sendPrompt: async (_sessionId: string, text: string) => { calls.push("send"); expect(text).toContain("second.txt"); },
    };
    await expect(submitHomeMessage(input)).rejects.toThrow("Copy failed");
    expect(pending.sessionId).toBeNull();
    expect(calls).toEqual(["first", "second"]);
    fail = false;
    await submitHomeMessage(input);
    expect(calls).toEqual(["first", "second", "second", "create", "send"]);
  });

  test("removing a staged file before retry excludes it from the message", async () => {
    const file = new File(["sample"], "removed.txt");
    const pending: PendingHomeMessage = { sessionId: "existing-session", uploads: new Map([[file, "attachment://workspace?name=removed.txt&path=.legalwork/attachments/id/removed.txt"]]) };
    await submitHomeMessage({
      workspaceId: "project", text: "Just this message", files: [], pending,
      client: { writeWorkspaceBinaryFile: async () => { throw new Error("Unexpected copy"); } },
      createSession: async () => { throw new Error("Unexpected session"); },
      sendPrompt: async (sessionId, text, context) => {
        expect(sessionId).toBe("existing-session");
        expect(text).toBe("Just this message");
        expect(context).toBe("");
      },
    });
  });
});
