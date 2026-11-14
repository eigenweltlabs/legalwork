import { expect, test } from "bun:test";
import { launcherInvocationResultAction, resolveLauncherInvocationResult } from "../src/react-app/launcher/launcher-invocation-result";
import { resultChatProject } from "../src/react-app/launcher/launcher-result-chat";
import type { LauncherSearchResult } from "@legalwork/types/launcher";

type Client = Parameters<typeof resolveLauncherInvocationResult>[1];
function client(overrides: Partial<Client>): Client {
  const unused = async () => { throw new Error("Unexpected lookup"); };
  return { visibleLauncherFiles: unused, launcherPreview: unused, assistantConversation: unused, listWorkspaces: unused, ...overrides };
}

test("exact file handoff validates the selected source rather than title-searching another copy", async () => {
  const reference = { kind: "files", id: "Contract.docx", path: "Contract.docx", workspaceId: "matter-b", sourceId: "local:matter-b" } satisfies Parameters<typeof resolveLauncherInvocationResult>[0];
  const found = await resolveLauncherInvocationResult(reference, client({ visibleLauncherFiles: async items => {
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject(reference);
    return { items: items.map<LauncherSearchResult>(item => ({ ...item, sourceKind: "wiki", subtitle: "Current Wiki Name" })) };
  } }));
  expect(found).toMatchObject({ ...reference, sourceKind: "wiki", subtitle: "Current Wiki Name" });
  await expect(resolveLauncherInvocationResult(reference, client({ visibleLauncherFiles: async () => ({ items: [] }) }))).rejects.toThrow();
});

test("job handoff asks for the exact project session and propagates unavailable failures", async () => {
  const reference = { kind: "chats", id: "session-id", sessionId: "session-id", workspaceId: "matter", sourceId: "local:matter" } satisfies Parameters<typeof resolveLauncherInvocationResult>[0];
  const found = await resolveLauncherInvocationResult(reference, client({ launcherPreview: async input => {
    expect(input).toEqual({ kind: "chats", id: "session-id", workspaceId: "matter" });
    return { kind: "chats", id: "session-id", title: "Current job title", meta: [], text: "", truncated: false, source: "messages", updatedAt: 12 };
  } }));
  expect(found).toMatchObject({ ...reference, title: "Current job title", updatedAt: 12 });
  await expect(resolveLauncherInvocationResult(reference, client({ launcherPreview: async () => { throw new Error("Deleted chat"); } }))).rejects.toThrow("Deleted chat");
});

test("external Ask uses the native action policy and waits for a destination for Wiki or added-folder sources", async () => {
  const projects = [{ id: "matter" }, { id: "wiki", preset: "wiki" }];
  for (const reference of [
    { kind: "files", id: "contract.docx", path: "contract.docx", workspaceId: "wiki", sourceId: "local:wiki" },
    { kind: "files", id: "contract.docx", path: "contract.docx", workspaceId: null, sourceId: "folder:library", folderId: "library" },
  ] satisfies Parameters<typeof resolveLauncherInvocationResult>[0][]) {
    const found = await resolveLauncherInvocationResult(reference, client({ visibleLauncherFiles: async items => ({ items }) }));
    expect(launcherInvocationResultAction(found, "ask")).toBe("ask");
    expect(resultChatProject([found], projects)).toBeUndefined();
    expect(resultChatProject([found], projects, "matter")).toBe("matter");
    expect(launcherInvocationResultAction(found, "summarize")).toBe("summarize");
  }
  const base: LauncherSearchResult = { kind: "tasks", id: "task", workspaceId: "matter", sourceId: "tasks", title: "Task", score: 0, updatedAt: 0, match: "exact", actions: ["open"] };
  expect(launcherInvocationResultAction(base, "ask")).toBe("ask");
  expect(() => launcherInvocationResultAction(base, "summarize")).toThrow();
  expect(() => launcherInvocationResultAction({ ...base, kind: "chats" }, "ask")).toThrow();
  expect(() => launcherInvocationResultAction({ ...base, kind: "files", path: "", fileType: "folder" }, "ask")).toThrow();
});
