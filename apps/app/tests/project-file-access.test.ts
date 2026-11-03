import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createProjectFileAccess } from "../src/react-app/domains/workspace/project-file-context";
import { createLegalworkServerClient, type LegalworkServerClient } from "../src/app/lib/legalwork-server";
import type { WorkspaceSessionGroup } from "../src/app/types";
import { parseWorkspaceAttachmentMention, uploadWorkspaceAttachment, workspaceAttachmentDisplayText } from "../src/react-app/domains/session/surface/composer/workspace-attachment";

const groups: WorkspaceSessionGroup[] = [
  { workspace: { id: "a", name: "Source", path: "/fixture/a", preset: "starter", workspaceType: "local" }, status: "ready", sessions: [] },
  { workspace: { id: "b", name: "Target", path: "/fixture/b", preset: "starter", workspaceType: "local" }, status: "ready", sessions: [] },
];
const source = { projectId: "a", workspaceId: "a", path: "same.md", name: "same.md" };

test("source resolution uses registered project endpoints and rejects mismatched server ids", () => {
  const local = createLegalworkServerClient({ baseUrl: "http://localhost:4000", token: "local-token" });
  const access = createProjectFileAccess(groups, local, () => "draft");
  expect(access.sourceProject(source).client).toBe(local);
  expect(() => access.sourceProject({ ...source, projectId: "rem_c", workspaceId: "server-c" })).toThrow();
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
  const copied = await access.readSaved({ ...source, path: ".legalwork/attachments/id/Contract.docx", name: "Contract.docx · Source" });
  expect(copied.filename).toBe("Contract.docx");
  const legacy = await access.readSaved({ ...source, path: ".legalwork/attachments/id/Contract.docx___Source", name: "Contract.docx · Source · Source" });
  expect(legacy.filename).toBe("Contract.docx");
  mutate = true;
  await expect(access.readSaved(source)).rejects.toThrow("changed during");
});

test("cloud project attachments keep the checked-out filename while storage calls retain opaque identities", async () => {
  const remotePath = "~lw~Zm9sZGVy~Matters/~lw~cHJvdmlkZXItZmlsZQ~Rechnung (Signatur).pdf";
  const localPath = ".legalwork/storage-downloads/file-copy/Rechnung (Signatur).pdf";
  const bytes = new TextEncoder().encode("original PDF bytes");
  const client: LegalworkServerClient = {
    ...createLegalworkServerClient({ baseUrl: "http://localhost:4000" }),
    checkoutStorageFile: async (workspace, connection, path) => {
      expect(workspace).toBe("a"); expect(connection).toBe("connector:google-drive:account"); expect(path).toBe(remotePath);
      return { localPath, contentType: "application/pdf", version: "source-version", size: bytes.length, updatedAt: 1, writable: false, localWritable: true };
    },
    statWorkspaceFile: async (_workspace, path) => { expect(path).toBe(localPath); return { path, exists: true, kind: "file", size: bytes.length, updatedAt: 1 }; },
    downloadWorkspaceFile: async (_workspace, path) => { expect(path).toBe(localPath); return { data: bytes.buffer, filename: "Rechnung (Signatur).pdf", contentType: "application/pdf" }; },
  };
  const access = createProjectFileAccess(groups, client, () => "draft");
  const saved = await access.readSaved({ ...source, connectionId: "connector:google-drive:account", path: remotePath, name: "Rechnung (Signatur).pdf" });
  expect(saved.filename).toBe("Rechnung (Signatur).pdf");
  const mention = await uploadWorkspaceAttachment({ writeWorkspaceBinaryFile: async (_workspace, input) => {
    expect(new Uint8Array(input.data)).toEqual(bytes);
    expect(input.path).not.toContain("~lw~"); expect(input.path).not.toContain("_lw_");
    return { ok: true, path: input.path, bytes: input.data.byteLength, updatedAt: 1 };
  } }, "b", new File([saved.data], saved.filename, { type: saved.contentType }));
  expect(parseWorkspaceAttachmentMention(mention)?.name).toBe("Rechnung (Signatur).pdf");
  expect(workspaceAttachmentDisplayText(mention)).toStartWith("[Rechnung (Signatur).pdf](");
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
