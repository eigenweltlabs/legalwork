import { describe, expect, test } from "bun:test";
import { hashToken, shortId, parseList, ensureDir, exists, renameWithRetry } from "./utils.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("hashToken", () => {
  test("returns consistent hash for same input", () => {
    const a = hashToken("my-secret-token");
    const b = hashToken("my-secret-token");
    expect(a).toBe(b);
  });

  test("returns different hashes for different inputs", () => {
    const a = hashToken("token-a");
    const b = hashToken("token-b");
    expect(a).not.toBe(b);
  });

  test("returns a hex string", () => {
    const hash = hashToken("test");
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

describe("shortId", () => {
  test("returns a non-empty string", () => {
    const id = shortId();
    expect(id.length).toBeGreaterThan(0);
  });

  test("returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => shortId()));
    expect(ids.size).toBe(100);
  });
});

describe("parseList", () => {
  test("splits comma-separated values", () => {
    expect(parseList("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("trims whitespace", () => {
    expect(parseList(" a , b , c ")).toEqual(["a", "b", "c"]);
  });

  test("filters empty entries", () => {
    expect(parseList("a,,b,")).toEqual(["a", "b"]);
  });

  test("returns empty array for falsy input", () => {
    expect(parseList(undefined)).toEqual([]);
    expect(parseList("")).toEqual([]);
  });
});

describe("ensureDir + exists", () => {
  test("creates nested directory and reports it exists", async () => {
    const dir = join(tmpdir(), `legalwork-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const nested = join(dir, "a", "b", "c");

    expect(await exists(nested)).toBe(false);
    await ensureDir(nested);
    expect(await exists(nested)).toBe(true);
  });
});

describe("renameWithRetry", () => {
  test("moves the file into place", async () => {
    const root = await mkdtemp(join(tmpdir(), "legalwork-rename-"));
    await writeFile(join(root, "src.tmp"), "payload\n", "utf8");

    await renameWithRetry(join(root, "src.tmp"), join(root, "dest.json"));

    expect(await readFile(join(root, "dest.json"), "utf8")).toBe("payload\n");
    expect(await exists(join(root, "src.tmp"))).toBe(false);
  });

  test("propagates an error that is not a transient lock", async () => {
    // Only EPERM/EACCES/EBUSY are worth waiting out; everything else must
    // surface immediately rather than after the whole backoff.
    const root = await mkdtemp(join(tmpdir(), "legalwork-rename-"));
    const started = Date.now();

    await expect(renameWithRetry(join(root, "missing.tmp"), join(root, "dest.json"))).rejects.toThrow();

    expect(Date.now() - started).toBeLessThan(500);
  });
});
