import { afterEach, describe, expect, test } from "bun:test";

import { collectLegalMemoryFolderFiles, FOLDER_EXPORT_LIMITS } from "./legalmemory-fetch.js";

const nativeFetch = globalThis.fetch;
const server = { name: "legalmemory", url: "https://memory.firm.example/mcp" };

type Level = { folders: { name: string; path: string }[]; files: string[] };

/** Serve the appliance's `/api/tree/children` out of a fixed folder map. */
function serveTree(levels: Record<string, Level>, pageSize = 1000) {
  const requests: { path: string; offset: number }[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    // Only the direct `/api/tree/*` route answers; the proxy candidate 404s,
    // which is exactly what a raw appliance does.
    if (!url.pathname.endsWith("/api/tree/children")) return new Response("", { status: 404 });
    const path = url.searchParams.get("path") ?? "";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    requests.push({ path, offset });
    const level = levels[path] ?? { folders: [], files: [] };
    const page = level.files.slice(offset, offset + pageSize);
    return Response.json({
      source_id: "src-1",
      path,
      folders: level.folders.map((folder) => ({ ...folder, files: 0 })),
      files: page.map((name) => ({
        source_object_id: `${path}/${name}`,
        source_id: "src-1",
        name,
        path: `${path}/${name}`,
        mime_type: null,
        size_bytes: null,
        mtime: null,
        document_id: `doc-${path}/${name}`,
      })),
      pagination: {
        total: level.files.length,
        offset,
        limit: pageSize,
        returned: page.length,
        has_more: offset + page.length < level.files.length,
      },
    });
  }) as typeof globalThis.fetch;
  return requests;
}

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

describe("collectLegalMemoryFolderFiles", () => {
  test("walks subfolders and names each file by where it sits in the folder", async () => {
    serveTree({
      Matter: { folders: [{ name: "Pleadings", path: "Matter/Pleadings" }], files: ["Cover.pdf"] },
      "Matter/Pleadings": { folders: [{ name: "2026", path: "Matter/Pleadings/2026" }], files: ["Answer.docx"] },
      "Matter/Pleadings/2026": { folders: [], files: ["Reply.docx"] },
    });

    const { entries, truncated } = await collectLegalMemoryFolderFiles(server, { sourceId: "src-1", path: "Matter" });

    expect(truncated).toBe(false);
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "Cover.pdf",
      "Pleadings/Answer.docx",
      "Pleadings/2026/Reply.docx",
    ]);
    expect(entries[0]?.file.document_id).toBe("doc-Matter/Cover.pdf");
  });

  test("pages through a folder without repeating its subfolders", async () => {
    const requests = serveTree(
      {
        Matter: { folders: [{ name: "Sub", path: "Matter/Sub" }], files: ["a.pdf", "b.pdf", "c.pdf"] },
        "Matter/Sub": { folders: [], files: ["d.pdf"] },
      },
      2,
    );

    const { entries } = await collectLegalMemoryFolderFiles(server, { sourceId: "src-1", path: "Matter" });

    expect(entries.map((entry) => entry.relativePath)).toEqual(["a.pdf", "b.pdf", "c.pdf", "Sub/d.pdf"]);
    expect(requests.filter((request) => request.path === "Matter").map((request) => request.offset)).toEqual([0, 2]);
  });

  test("stops at the file ceiling and says the folder was cut short", async () => {
    const files = Array.from({ length: FOLDER_EXPORT_LIMITS.files + 10 }, (_, index) => `doc-${index}.pdf`);
    serveTree({ Matter: { folders: [], files } });

    const { entries, truncated } = await collectLegalMemoryFolderFiles(server, { sourceId: "src-1", path: "Matter" });

    expect(entries).toHaveLength(FOLDER_EXPORT_LIMITS.files);
    expect(truncated).toBe(true);
  });

  test("stops descending at the depth ceiling instead of following a cycle", async () => {
    // A folder that lists itself as its own child: the appliance should never
    // do this, but a bounded walk must not hang if it does.
    serveTree({ Matter: { folders: [{ name: "Matter", path: "Matter" }], files: ["a.pdf"] } });

    const { entries, truncated } = await collectLegalMemoryFolderFiles(server, { sourceId: "src-1", path: "Matter" });

    expect(truncated).toBe(true);
    expect(entries).toHaveLength(FOLDER_EXPORT_LIMITS.depth + 1);
  });
});
