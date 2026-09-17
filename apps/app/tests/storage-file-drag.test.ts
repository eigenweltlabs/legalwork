import { describe, expect, test } from "bun:test";

import {
  STORAGE_FILE_DRAG_TYPE,
  hasStorageFileDrag,
  materializeStorageFile,
  readStorageFileDrag,
  storageFileDragToFile,
  writeStorageFileDrag,
} from "../src/app/lib/storage-file-drag";

/** Minimal DataTransfer good enough for the drag payload contract. */
function dataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    effectAllowed: "none",
    get types() {
      return Array.from(store.keys());
    },
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
  } as unknown as DataTransfer;
}

const root = { id: "conn-1", name: "Secure Cloud", kind: "s3", writable: true } as const;
const entry = {
  path: "1001-00003/Engagement/engagement-letter.docx",
  name: "engagement-letter.docx",
  kind: "file",
  size: 1234,
  modifiedAt: null,
} as const;

describe("storage-file-drag", () => {
  test("round-trips a storage entry through the drag payload", () => {
    const dt = dataTransfer();
    writeStorageFileDrag(dt, root, entry);

    expect(hasStorageFileDrag(dt)).toBe(true);
    expect(readStorageFileDrag(dt)).toEqual({
      connectionId: "conn-1",
      connectionName: "Secure Cloud",
      path: "1001-00003/Engagement/engagement-letter.docx",
      name: "engagement-letter.docx",
    });
  });

  test("exposes a plain-text fallback for drop targets that only read text", () => {
    const dt = dataTransfer();
    writeStorageFileDrag(dt, root, entry);
    expect(dt.getData("text/plain")).toBe(entry.path);
  });

  test("ignores a drag that carries no storage payload", () => {
    const dt = dataTransfer();
    expect(hasStorageFileDrag(dt)).toBe(false);
    expect(readStorageFileDrag(dt)).toBeNull();
  });

  test("rejects malformed or partial payloads instead of yielding a broken item", () => {
    for (const payload of ['{"connectionId":"c"}', '{"connectionId":"","path":"a","connectionName":"n","name":"a"}', "not json"]) {
      const dt = dataTransfer();
      dt.setData(STORAGE_FILE_DRAG_TYPE, payload);
      expect(readStorageFileDrag(dt)).toBeNull();
    }
  });

  test("checks the object out into the workspace before the mention is usable", async () => {
    const calls: string[] = [];
    const client = {
      checkoutStorageFile: async (workspaceId: string, id: string, path: string) => {
        calls.push(`checkout:${workspaceId}:${id}:${path}`);
        return { localPath: ".legalwork/storage/engagement-letter.docx" };
      },
      downloadWorkspaceFile: async (_workspaceId: string, path: string) => {
        calls.push(`download:${path}`);
      },
    };

    const copy = await materializeStorageFile(client as never, "ws-1", {
      connectionId: "conn-1",
      connectionName: "Secure Cloud",
      path: entry.path,
      name: entry.name,
    });

    expect(copy.localPath).toBe(".legalwork/storage/engagement-letter.docx");
    expect(calls).toEqual([
      `checkout:ws-1:conn-1:${entry.path}`,
      "download:.legalwork/storage/engagement-letter.docx",
    ]);
  });

  test("waits for the workspace copy to become readable instead of failing on the first miss", async () => {
    let reads = 0;
    const client = {
      checkoutStorageFile: async () => ({ localPath: "copy.docx" }),
      downloadWorkspaceFile: async () => {
        reads += 1;
        if (reads < 3) throw new Error("not ready");
      },
    };

    const copy = await materializeStorageFile(client as never, "ws-1", {
      connectionId: "conn-1",
      connectionName: "Secure Cloud",
      path: entry.path,
      name: entry.name,
    });

    expect(copy.localPath).toBe("copy.docx");
    expect(reads).toBe(3);
  });

  test("turns the checked-out bytes into a named upload file", async () => {
    const client = {
      checkoutStorageFile: async () => ({
        localPath: "copy.docx",
        contentType: "application/octet-stream",
        version: "v1",
        size: 8,
        updatedAt: 1,
        writable: true,
        localWritable: true,
      }),
      downloadWorkspaceFile: async () => ({
        data: new TextEncoder().encode("document").buffer,
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "engagement-letter.docx",
        updatedAt: 1,
      }),
    };

    const file = await storageFileDragToFile(client, "ws-1", {
      connectionId: "conn-1",
      connectionName: "Secure Cloud",
      path: entry.path,
      name: entry.name,
    });

    expect(file.name).toBe("engagement-letter.docx");
    expect(file.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(await file.text()).toBe("document");
  });

  test("surfaces the checkout failure rather than inserting a dangling mention", async () => {
    const client = {
      checkoutStorageFile: async () => {
        throw new Error("connection refused");
      },
      downloadWorkspaceFile: async () => {},
    };

    await expect(
      materializeStorageFile(client as never, "ws-1", {
        connectionId: "conn-1",
        connectionName: "Secure Cloud",
        path: entry.path,
        name: entry.name,
      }),
    ).rejects.toThrow("connection refused");
  });
});
