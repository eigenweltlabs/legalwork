import { describe, expect, test } from "bun:test";
import { importReviewFile, importReviewFiles, type ReviewFileClient, type ReviewFileSource } from "../src/react-app/domains/reviews/review-file-import";
import { REVIEW_MAX_DOCUMENTS } from "@legalwork/types/reviews";

function fixture() {
  const files = new Map<string, ArrayBuffer>(), calls: string[] = [];
  const put = (workspace: string, path: string, text: string) => files.set(`${workspace}/${path}`, new TextEncoder().encode(text).buffer);
  const client: ReviewFileClient = {
    statWorkspaceFile: async (workspace, path) => ({ ok: true, path, exists: files.has(`${workspace}/${path}`), kind: "file", size: files.get(`${workspace}/${path}`)?.byteLength }),
    writeWorkspaceBinaryFile: async (workspace, { path, data }) => { calls.push(`write:${path}`); files.set(`${workspace}/${path}`, data); return { ok: true, path, bytes: data.byteLength, updatedAt: 1 }; },
    downloadWorkspaceFile: async (workspace, path) => { calls.push(`read:${path}`); const data = files.get(`${workspace}/${path}`); if (!data) throw new Error("Offline"); return { data, contentType: "text/plain", filename: path, updatedAt: 1 }; },
    checkoutStorageFile: async (workspace, connection, path) => {
      calls.push(`checkout:${connection}`); const localPath = `.legalwork/storage/${path}`; put(workspace, localPath, "Cloud document");
      return { localPath, contentType: "text/plain", version: "1", size: 14, updatedAt: 1, writable: false, localWritable: true };
    },
    legalMemoryOpen: async (workspace, { document_id }) => { calls.push(`memory:${document_id}`); const path = `memory/${document_id}.txt`; put(workspace, path, "Memory document"); return { ok: true, path, bytes: 15, mimeType: "text/plain" }; },
  };
  return { client, files, calls, put };
}
function upload(name = "Contract.txt", content = "Contract"): ReviewFileSource { return { kind: "upload", file: new File([content], name) }; }
const cloud: ReviewFileSource = { kind: "storage", file: { connectionId: "cloud", connectionName: "Cloud", path: "Contract.txt", name: "Contract.txt" } };

describe("review file intake", () => {
  test("references project files without copying and rejects missing references", async () => {
    const f = fixture(); f.put("ws", "Contract.txt", "Original");
    const source: ReviewFileSource = { kind: "workspace", file: { workspaceId: "ws", path: "Contract.txt", name: "Contract.txt" } };
    expect(await importReviewFile(f.client, "ws", source)).toBe("Contract.txt"); expect(f.calls).toEqual([]);
    f.files.clear(); await expect(importReviewFile(f.client, "ws", source)).rejects.toThrow();
  });
  test("preserves readable Unicode names and bytes", async () => {
    const f = fixture(); const path = await importReviewFile(f.client, "ws", upload("Übertragung 中文.txt", "Exact bytes ä"));
    expect(path).toBe("Review documents/Übertragung 中文.txt");
    expect(new TextDecoder().decode(f.files.get(`ws/${path}`))).toBe("Exact bytes ä");
  });
  test("deduplicates identical drops and never overwrites different same-named files", async () => {
    const f = fixture();
    const result = await importReviewFiles({ client: f.client, workspaceId: "ws", existing: [], sources: [upload(), upload(), upload("Contract.txt", "Different")] });
    expect(result.paths).toEqual(["Review documents/Contract.txt", "Review documents/Contract (2).txt"]); expect(result.failures).toEqual([]);
    expect(f.calls.filter(call => call.startsWith("write:"))).toHaveLength(2);
  });
  test("copies another project's source without moving it", async () => {
    const f = fixture(); f.put("other", "Contract.txt", "Source bytes");
    const path = await importReviewFile(f.client, "ws", { kind: "workspace", file: { workspaceId: "other", path: "Contract.txt", name: "Contract.txt" } });
    expect(f.files.get(`ws/${path}`)).toEqual(f.files.get("other/Contract.txt")); expect(f.files.has("other/Contract.txt")).toBe(true);
  });
  test("uses connected storage checkout and readiness before adding a source", async () => {
    const f = fixture(); expect(await importReviewFile(f.client, "ws", cloud)).toBe(".legalwork/storage/Contract.txt");
    expect(f.calls).toEqual(["checkout:cloud", "read:.legalwork/storage/Contract.txt"]);
  });
  test("supports indexed Memory Drive documents", async () => {
    const f = fixture();
    expect(await importReviewFile(f.client, "ws", { kind: "memory", file: { document_id: "doc", name: "Contract.txt", path: "Contract.txt", source_id: "source", source_object_id: "object" } })).toBe("memory/doc.txt");
  });
  test("keeps valid files when a cloud download or another file fails", async () => {
    const f = fixture(); f.client.checkoutStorageFile = async () => { throw new Error("Cloud offline"); };
    const result = await importReviewFiles({ client: f.client, workspaceId: "ws", existing: [], sources: [cloud, upload(), upload("bad.exe")] });
    expect(result.paths).toHaveLength(1); expect(result.failures).toHaveLength(2); expect(result.failures[0]).toContain("Cloud offline");
  });
  test("enforces limits and handles cancellation before writing", async () => {
    const f = fixture();
    const result = await importReviewFiles({ client: f.client, workspaceId: "ws", existing: Array.from({ length: REVIEW_MAX_DOCUMENTS }, (_, i) => `${i}.txt`), sources: [upload()] });
    expect(result.paths).toEqual([]); expect(result.failures).toHaveLength(1);
    const controller = new AbortController(); controller.abort();
    await expect(importReviewFiles({ client: f.client, workspaceId: "ws", existing: [], sources: [upload()], signal: controller.signal })).rejects.toThrow();
    const large = new File([], "large.pdf"); Object.defineProperty(large, "size", { value: 65 * 1024 * 1024 });
    await expect(importReviewFile(f.client, "ws", { kind: "upload", file: large })).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  test("makes Windows reserved names and separators safe", async () => {
    const f = fixture(); expect(await importReviewFile(f.client, "ws", upload("CON.txt"))).toBe("Review documents/_CON.txt");
    expect(await importReviewFile(f.client, "ws", upload("a:b.txt"))).toBe("Review documents/a_b.txt");
  });
});
