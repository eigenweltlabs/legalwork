import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createProjectFileAccess } from "../src/react-app/domains/workspace/project-file-context";
import { createLegalworkServerClient, type LegalworkServerClient } from "../src/app/lib/legalwork-server";
import type { WorkspaceSessionGroup } from "../src/app/types";

const groups: WorkspaceSessionGroup[] = [
  { workspace: { id: "a", name: "Source", path: "/fixture/a", preset: "starter", workspaceType: "local" }, status: "ready", sessions: [] },
  { workspace: { id: "b", name: "Target", path: "/fixture/b", preset: "starter", workspaceType: "local" }, status: "ready", sessions: [] },
  { workspace: { id: "rem_c", name: "Remote", path: "/fixture/c", preset: "starter", workspaceType: "remote", baseUrl: "https://saved.example", legalworkWorkspaceId: "server-c", legalworkToken: "saved-token" }, status: "ready", sessions: [] },
];
const source = { projectId: "a", workspaceId: "a", path: "same.md", name: "same.md" };

test("source resolution uses registered project endpoints and rejects mismatched server ids", () => {
  const local = createLegalworkServerClient({ baseUrl: "http://localhost:4000", token: "local-token" });
  const access = createProjectFileAccess(groups, local, () => "draft");
  expect(access.sourceProject(source).client).toBe(local);
  expect(access.sourceProject({ ...source, projectId: "rem_c", workspaceId: "server-c" }).baseUrl).toBe("https://saved.example");
  expect(() => access.sourceProject({ ...source, projectId: "unknown" })).toThrow();
  expect(() => access.sourceProject({ ...source, workspaceId: "b" })).toThrow();
  expect(access.identify(local, "b", { path: "same.md", name: "same.md" })).toEqual({ ...source, projectId: "b", workspaceId: "b" });
});

test("saved snapshots read only from the origin and detect source changes during transfer", async () => {
  const calls: string[] = [];
  let version = 1;
  let mutate = false;
  const bytes = new TextEncoder().encode("Saved original");
  const client: LegalworkServerClient = {
    ...createLegalworkServerClient({ baseUrl: "http://localhost:4000" }),
    statWorkspaceFile: async (id, path) => { calls.push(`${id}/${path}`); return { path, exists: true, kind: "file", size: bytes.length, updatedAt: version, fileId: "fixture" }; },
    downloadWorkspaceFile: async (id, path) => { calls.push(`${id}/${path}`); if (mutate) version++; return { data: bytes.buffer, filename: "same.md", contentType: "text/markdown" }; },
  };
  const access = createProjectFileAccess(groups, client, () => "draft");
  const saved = await access.readSaved(source);
  expect(saved.version).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(saved.projectName).toBe("Source");
  expect(calls).toEqual(["a/same.md", "a/same.md", "a/same.md"]);
  mutate = true;
  await expect(access.readSaved(source)).rejects.toThrow("changed during");
});

test("a drop creates a draft in the receiving project, preserves text, and never sends it", async () => {
  const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store");
  const { parseWorkspaceAttachmentMention } = await import("../src/react-app/domains/session/surface/composer/workspace-attachment");
  const id = "cross-project-draft-test";
  const local = createLegalworkServerClient({ baseUrl: "http://localhost:4000" });
  const created: string[] = [];
  const access = createProjectFileAccess(groups, local, project => { created.push(project); useComposerStateStore.getState().setDraft(id, "Please compare"); return id; });
  await access.newChat("b", source);
  const editor = useComposerStateStore.getState().sessions[id];
  expect(created).toEqual(["b"]);
  expect(editor.draft).toStartWith("Please compare @");
  expect(Object.keys(editor.mentions)).toHaveLength(1);
  expect(parseWorkspaceAttachmentMention(Object.keys(editor.mentions)[0])?.source).toEqual(source);
  useComposerStateStore.getState().clearSession(id);
});

test("a multi-file drop creates one draft containing every source and rejects unavailable projects before creating it", async () => {
  const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store");
  const id = "multi-project-draft-test";
  const local = createLegalworkServerClient({ baseUrl: "http://localhost:4000" });
  let created = 0;
  const access = createProjectFileAccess(groups, local, () => { created++; return id; });
  await access.newChat("b", [source, { ...source, path: "second.md", name: "second.md" }]);
  expect(created).toBe(1);
  expect(Object.keys(useComposerStateStore.getState().sessions[id].mentions)).toHaveLength(2);
  await expect(access.newChat("b", [source, { ...source, projectId: "missing" }])).rejects.toThrow();
  expect(created).toBe(1);
  useComposerStateStore.getState().clearSession(id);
});
