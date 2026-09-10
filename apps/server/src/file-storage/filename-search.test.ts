import { describe, expect, test } from "bun:test";
import type { StorageFilenameSearchPage, StoragePage } from "@legalwork/types/file-storage";
import { entry } from "./common.js";
import { searchFilenames } from "./filename-search.js";

describe("connected storage filename search", () => {
  test("finds literal case-insensitive substrings in unopened nested folders, not folder names", async () => {
    const folders: Record<string, StoragePage> = {
      "": {
        entries: [entry("competitor", "folder"), entry("Firm DMS", "folder")],
      },
      competitor: { entries: [entry("competitor/irrelevant.txt", "file")] },
      "Firm DMS": { entries: [entry("Firm DMS/Antitrust", "folder")] },
      "Firm DMS/Antitrust": {
        entries: [
          entry("Firm DMS/Antitrust/Competitor-identification.xlsx", "file"),
          entry("Firm DMS/Antitrust/[Final]*.txt", "file"),
        ],
      },
    };
    const adapter = { list: async (path: string) => folders[path]! };
    const found = await searchFilenames(adapter, { query: "PETITOR", path: "" }, "s3:1");
    expect(found.entries.map((item) => item.path)).toEqual(["Firm DMS/Antitrust/Competitor-identification.xlsx"]);
    expect(found.scanned).toBe(3);
    expect(found.nextCursor).toBeUndefined();
    expect((await searchFilenames(adapter, { query: "[final]*", path: "Firm DMS" }, "s3:1")).entries).toHaveLength(1);
  });

  test("uses flat metadata pages for object stores and resumes sparse matches past 9,000 files", async () => {
    let requests = 0;
    const adapter = {
      list: async () => {
        throw new Error("Must not walk virtual folders");
      },
      listFiles: async (_path: string, cursor?: string) => {
        requests++;
        const offset = Number(cursor ?? 0);
        return {
          entries: Array.from({ length: Math.min(100, 9287 - offset) }, (_, i) =>
            entry(`Firm DMS/${offset + i}/${offset + i === 9286 ? "Late-Competitor.xlsx" : "other.txt"}`, "file"),
          ),
          nextCursor: offset + 100 < 9287 ? String(offset + 100) : undefined,
        };
      },
    };
    let page = await searchFilenames(adapter, { query: "competitor", path: "" }, "s3:1");
    expect(requests).toBe(10);
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBeDefined();
    let scanned = page.scanned;
    while (page.nextCursor) {
      const previousRequests = requests;
      page = await searchFilenames(adapter, { query: "competitor", path: "", cursor: page.nextCursor }, "s3:1");
      expect(requests - previousRequests).toBeLessThanOrEqual(10);
      scanned += page.scanned;
    }
    expect(scanned).toBe(9287);
    expect(page.entries[0]?.name).toBe("Late-Competitor.xlsx");
  });

  test("paginates dense results without dropping matches inside a provider page; retries are idempotent", async () => {
    const entries = Array.from({ length: 257 }, (_, i) => entry(`nested/Match-${i}.txt`, "file"));
    const adapter = {
      list: async () => ({ entries: [] }),
      listFiles: async () => ({ entries }),
    };
    const first = await searchFilenames(adapter, { query: "match", path: "" }, "a");
    expect(first.entries).toHaveLength(100);
    const input = { query: "match", path: "", cursor: first.nextCursor };
    const second = await searchFilenames(adapter, input, "a");
    expect(await searchFilenames(adapter, input, "a")).toEqual(second);
    const third = await searchFilenames(adapter, { ...input, cursor: second.nextCursor }, "a");
    expect([...first.entries, ...second.entries, ...third.entries]).toEqual(entries);
    expect(third.nextCursor).toBeUndefined();
    for (const [query, path, revision] of [
      ["other", "", "a"],
      ["match", "nested", "a"],
      ["match", "", "b"],
    ]) {
      await expect(searchFilenames(adapter, { ...input, query: query!, path: path! }, revision!)).rejects.toMatchObject(
        { status: 400 },
      );
    }
  });

  test("resumes directory pages and parents, including duplicate filenames in different folders", async () => {
    const expected = Array.from({ length: 125 }, (_, i) => `folder-${i}/same.txt`);
    const adapter = {
      list: async (path: string, cursor?: string): Promise<StoragePage> => {
        if (path) return { entries: [entry(`${path}/same.txt`, "file")] };
        return cursor
          ? {
              entries: expected.slice(100).map((path) => entry(path.split("/")[0]!, "folder")),
            }
          : {
              entries: expected.slice(0, 100).map((path) => entry(path.split("/")[0]!, "folder")),
              nextCursor: "100",
            };
      },
    };
    const found: string[] = [];
    let page: StorageFilenameSearchPage;
    let cursor: string | undefined;
    do {
      page = await searchFilenames(adapter, { query: "same", path: "", cursor }, "smb:1");
      found.push(...page.entries.map((item) => item.path));
      cursor = page.nextCursor;
    } while (cursor);
    expect(found).toEqual(expected);
  });

  test("cancels work between pages and propagates failures instead of reporting no matches", async () => {
    const controller = new AbortController();
    let requests = 0;
    const adapter = {
      list: async () => {
        requests++;
        controller.abort();
        return { entries: [], nextCursor: "next" };
      },
    };
    await expect(searchFilenames(adapter, { query: "test", path: "" }, "a", controller.signal)).rejects.toThrow();
    expect(requests).toBe(1);
    await expect(
      searchFilenames(
        {
          list: async () => {
            throw new Error("Offline");
          },
        },
        { query: "test", path: "" },
        "a",
      ),
    ).rejects.toThrow("Offline");
  });

  test("rejects invalid cursors, traversal, out-of-scope entries and stalled pagination", async () => {
    const adapter = { list: async () => ({ entries: [] }) };
    await expect(searchFilenames(adapter, { query: "test", path: "", cursor: "broken" }, "a")).rejects.toMatchObject({
      status: 400,
    });
    await expect(searchFilenames(adapter, { query: "test", path: "../outside" }, "a")).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      searchFilenames(
        {
          list: async () => ({ entries: [entry("outside/file.txt", "file")] }),
        },
        { query: "file", path: "nested" },
        "a",
      ),
    ).rejects.toMatchObject({ code: "storage_invalid_listing" });
    await expect(
      searchFilenames({ list: async () => ({ entries: [], nextCursor: "same" }) }, { query: "file", path: "" }, "a"),
    ).rejects.toMatchObject({ code: "storage_listing_stalled" });
  });
});
