import { describe, expect, test } from "bun:test";
import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import type { StorageRoot } from "@legalwork/types/file-storage";
import { viewerFileTabs } from "../src/react-app/domains/session/panel/viewer-file-drop";

const empty = { projects: [], workspace: null, storage: null, memory: null, files: [] };
const unavailable = async (): Promise<never> => { throw new Error("Unexpected file API call"); };
const client: Pick<LegalworkServerClient, "storageRoots" | "legalMemoryOpen" | "downloadWorkspaceFile" | "writeWorkspaceBinaryFile"> = {
  storageRoots: unavailable,
  legalMemoryOpen: unavailable,
  downloadWorkspaceFile: unavailable,
  writeWorkspaceBinaryFile: unavailable,
};

describe("files dropped into document panes", () => {
  test("opens the original project file without copying or normalizing its path", async () => {
    const drop = { ...empty, workspace: { workspaceId: "workspace", path: "Matters/Contract.docx", name: "Contract.docx" } };
    const result = await viewerFileTabs(client, "workspace", drop).next();
    expect(result.value).toEqual({ id: "file:Matters/Contract.docx", type: "artifact", label: "Contract.docx", value: "Matters/Contract.docx", preview: "word" });
  });

  test("does not interpret another workspace's relative path in this workspace", async () => {
    const drop = { ...empty, workspace: { workspaceId: "other", path: "Contract.docx", name: "Contract.docx" } };
    await expect(viewerFileTabs(client, "workspace", drop).next()).rejects.toThrow("different workspace");
  });

  test("Memory Drive resolves an available root and preserves the cloud source", async () => {
    const root: StorageRoot = { id: "firm", name: "Firm files", kind: "webdav", writable: true };
    const drop = { ...empty, storage: { connectionId: "firm", connectionName: "Old name", path: "Matter/A.docx", name: "A.docx" } };
    const result = await viewerFileTabs({ ...client, storageRoots: async (workspaceId) => {
      expect(workspaceId).toBe("workspace");
      return { roots: [root] };
    } }, "workspace", drop).next();
    expect(result.value).toMatchObject({ type: "artifact", preview: "word", storage: {
      workspaceId: "workspace", root, file: { path: "Matter/A.docx", name: "A.docx", kind: "file" },
    } });
    expect(result.value?.value).toBeUndefined();
  });

  test("rejects disconnected Memory Drive sources", async () => {
    const drop = { ...empty, storage: { connectionId: "removed", connectionName: "Old drive", path: "A.docx", name: "A.docx" } };
    await expect(viewerFileTabs({ ...client, storageRoots: async () => ({ roots: [] }) }, "workspace", drop).next()).rejects.toThrow("no longer available");
  });

  test("external files still use working copies and are imported one at a time", async () => {
    const copied: string[] = [];
    const drop = { ...empty, files: [new File(["one"], "A.txt"), new File(["two"], "B.txt")] };
    const tabs = viewerFileTabs({ ...client, writeWorkspaceBinaryFile: async (workspaceId, payload) => {
      expect(workspaceId).toBe("workspace");
      copied.push(payload.path);
      return { ok: true, path: payload.path, bytes: payload.data.byteLength, updatedAt: 42 };
    } }, "workspace", drop);
    expect((await tabs.next()).value?.value).toStartWith(".legalwork/tmp/");
    await tabs.return();
    expect(copied).toHaveLength(1);
  });
});
