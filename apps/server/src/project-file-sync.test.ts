import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ApiError } from "./errors.js";
import { checkCondition, conflict, type StorageAdapter } from "./file-storage/common.js";
import {
  conflictCopyPath,
  decide,
  syncProjectFiles,
  type FileBase,
  type FileBaseStore,
  type FileSyncOptions,
} from "./project-file-sync.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The remote side: files by case-insensitive path, each with its sha256 as version. */
function memoryRemote() {
  const files = new Map<string, { path: string; bytes: Buffer }>();
  const version = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const adapter: StorageAdapter = {
    list: async () => ({ entries: [] }),
    // Listed as stored, unchecked: the engine has to cope with whatever a remote sends.
    listFiles: async () => ({
      entries: [...files.values()].map((file) => ({
        path: file.path,
        name: file.path.split("/").at(-1) ?? file.path,
        kind: "file" as const,
        size: file.bytes.byteLength,
        modifiedAt: null,
        version: version(file.bytes),
      })),
    }),
    stat: async (path) => {
      const file = files.get(path.toLowerCase());
      return file ? { size: file.bytes.byteLength, version: version(file.bytes) } : null;
    },
    read: async () => {
      throw new Error("not used");
    },
    download: async (path, destination) => {
      const file = files.get(path.toLowerCase());
      if (!file || destination === undefined) throw new ApiError(404, "storage_not_found", "missing");
      await writeFile(destination, file.bytes, { flag: "wx" });
      return { size: file.bytes.byteLength, version: version(file.bytes), sha256: version(file.bytes) };
    },
    write: async () => {
      throw new Error("not used");
    },
    upload: async (path, source, _contentType, condition) => {
      const current = files.get(path.toLowerCase());
      checkCondition(current ? { size: current.bytes.byteLength, version: version(current.bytes) } : null, condition);
      files.set(path.toLowerCase(), { path, bytes: typeof source === "string" ? await readFile(source) : source });
    },
    mkdir: async () => {},
    deleteFile: async (path, condition) => {
      const current = files.get(path.toLowerCase());
      if (!current) return;
      if (condition?.version && condition.version !== version(current.bytes)) conflict();
      files.delete(path.toLowerCase());
    },
  };
  const put = (path: string, text: string) => files.set(path.toLowerCase(), { path, bytes: Buffer.from(text) });
  const text = (path: string) => files.get(path.toLowerCase())?.bytes.toString();
  return { adapter, files, put, text };
}

function memoryBase(): FileBaseStore & { map: Map<string, FileBase> } {
  const map = new Map<string, FileBase>();
  const texts = new Map<string, string>();
  return {
    map,
    entries: () => new Map(map),
    put: (key, value) => void map.set(key, value),
    drop: (key) => {
      map.delete(key);
      texts.delete(key);
    },
    text: (key) => texts.get(key) ?? null,
    putText: (key, text) => {
      if (text === null) texts.delete(key);
      else texts.set(key, text);
    },
  };
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-project-sync-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const read = (path: string) => readFile(join(root, path), "utf8").catch(() => null);
  return { root, write, read };
}

type Setup = Awaited<ReturnType<typeof project>> & { remote: ReturnType<typeof memoryRemote>; base: ReturnType<typeof memoryBase> };

async function setup(): Promise<Setup> {
  return { ...(await project()), remote: memoryRemote(), base: memoryBase() };
}

function run(s: Setup, overrides: Partial<FileSyncOptions> = {}) {
  return syncProjectFiles({
    root: s.root,
    remote: s.remote.adapter,
    base: s.base,
    includes: () => true,
    reconcile: true,
    allowDeletions: false,
    label: "Anna Muster",
    maxFileBytes: 1024 * 1024,
    settleMs: 0,
    // Fixed, and after any file a test writes, so everything written counts as settled.
    now: () => new Date(2099, 8, 25, 14, 3),
    ...overrides,
  });
}

describe("decide", () => {
  test("carries whichever side moved away from the base", () => {
    expect(decide("a", "a", "a")).toBe("none");
    expect(decide("b", "a", "a")).toBe("upload");
    expect(decide("a", "b", "a")).toBe("download");
    expect(decide(null, "a", "a")).toBe("delete-remote");
    expect(decide("a", null, "a")).toBe("delete-local");
    expect(decide("b", "c", "a")).toBe("conflict");
    expect(decide("b", "b", "a")).toBe("adopt");
    expect(decide(null, null, "a")).toBe("forget");
  });

  test("lets an edit win over a deletion, on either side", () => {
    expect(decide(null, "b", "a")).toBe("download");
    expect(decide("b", null, "a")).toBe("upload");
  });

  test("treats two new files with different content as a conflict, never as one overwriting the other", () => {
    expect(decide("a", null, null)).toBe("upload");
    expect(decide(null, "a", null)).toBe("download");
    expect(decide("a", "b", null)).toBe("conflict");
    expect(decide("a", "a", null)).toBe("adopt");
  });
});

describe("syncProjectFiles", () => {
  test("transfers independent files in batches of four and reuses unchanged files", async () => {
    const s = await setup();
    for (let i = 0; i < 12; i++) await s.write(`file-${i}.txt`, `contents ${i}`);
    const upload = s.remote.adapter.upload;
    let active = 0, peak = 0, uploads = 0;
    s.remote.adapter.upload = async (...args) => {
      uploads++; peak = Math.max(peak, ++active);
      try { await new Promise(resolve => setTimeout(resolve, 5)); await upload(...args); }
      finally { active--; }
    };
    expect((await run(s)).uploaded).toBe(12);
    expect(peak).toBe(4); expect(s.base.entries().size).toBe(12);
    expect((await run(s)).uploaded).toBe(0); expect(uploads).toBe(12);
  });
  test("uploads new local files, downloads new remote ones, and adopts identical ones", async () => {
    const s = await setup();
    await s.write("Schriftsätze/Klage.pdf", "klage");
    await s.write("Notes/Termin.md", "same");
    s.remote.put("Vertrag.docx", "vertrag");
    s.remote.put("notes/termin.md", "same");

    const result = await run(s);

    expect(result).toMatchObject({ uploaded: 1, downloaded: 1, conflicts: [], pending: 0, stale: false });
    expect(s.remote.text("Schriftsätze/Klage.pdf")).toBe("klage");
    expect(await s.read("Vertrag.docx")).toBe("vertrag");
    expect([...s.base.map.keys()].sort()).toEqual(["notes/termin.md", "schriftsätze/klage.pdf", "vertrag.docx"]);
    // A second round finds nothing to do.
    expect(await run(s)).toMatchObject({ uploaded: 0, downloaded: 0, removedLocal: 0, removedRemote: 0 });
  });

  test("uploads an edit made here and downloads one made remotely, each against the version last seen", async () => {
    const s = await setup();
    await s.write("a.txt", "one");
    await s.write("b.txt", "one");
    await run(s);
    await s.write("a.txt", "two");
    await utimes(join(s.root, "a.txt"), new Date(), new Date(Date.now() - 60_000));
    s.remote.put("b.txt", "remote");

    const result = await run(s);

    expect(result).toMatchObject({ uploaded: 1, downloaded: 1 });
    expect(s.remote.text("a.txt")).toBe("two");
    expect(await s.read("b.txt")).toBe("remote");
    expect(s.base.map.get("b.txt")?.sha256).toBe(sha("remote"));
  });

  test("deletes remotely what was deleted here, and moves to the sync trash what was deleted remotely", async () => {
    const s = await setup();
    await s.write("gone-here.txt", "x");
    await s.write("Akte/gone-there.txt", "y");
    await run(s);
    await rm(join(s.root, "gone-here.txt"));
    s.remote.files.delete("akte/gone-there.txt");

    const result = await run(s);

    expect(result).toMatchObject({ removedRemote: 1, removedLocal: 1 });
    expect(s.remote.text("gone-here.txt")).toBeUndefined();
    expect(await s.read("Akte/gone-there.txt")).toBeNull();
    // Recoverable, and the emptied folder is gone.
    const trash = join(s.root, ".legalwork", "sync-trash");
    const [round] = await readdir(trash);
    expect(await readFile(join(trash, round, "Akte", "gone-there.txt"), "utf8")).toBe("y");
    expect(await readdir(s.root)).not.toContain("Akte");
  });

  test("keeps both versions when both sides edited a file", async () => {
    const s = await setup();
    await s.write("Klage.docx", "base");
    await run(s);
    await s.write("Klage.docx", "mine");
    await utimes(join(s.root, "Klage.docx"), new Date(), new Date(Date.now() - 60_000));
    s.remote.put("Klage.docx", "theirs");

    const result = await run(s);

    const copy = "Klage (Anna Muster, 2099-09-25 14.03).docx";
    expect(result.conflicts).toEqual([{ path: "Klage.docx", copyPath: copy }]);
    expect(await s.read("Klage.docx")).toBe("theirs");
    expect(await s.read(copy)).toBe("mine");
    // The copy reaches the firm too, under its own name.
    expect(s.remote.text(copy)).toBe("mine");
    expect(s.remote.text("Klage.docx")).toBe("theirs");
  });

  test("merges a note both sides edited in different places, here and at the firm, without a copy", async () => {
    const s = await setup();
    const note = "Notes/Termin-ee006b29.md";
    await s.write(note, "# Termin\n\nDer Mandant kommt am Montag um zehn Uhr.\n");
    await run(s);
    await s.write(note, "# Termin\n\nDer Mandant kommt am Dienstag um zehn Uhr.\n");
    await utimes(join(s.root, note), new Date(), new Date(Date.now() - 60_000));
    s.remote.put(note, "# Termin\n\nDer Mandant kommt am Montag um elf Uhr.\n");

    const result = await run(s);

    const merged = "# Termin\n\nDer Mandant kommt am Dienstag um elf Uhr.\n";
    expect(result).toMatchObject({ merged: 1, conflicts: [] });
    expect(await s.read(note)).toBe(merged);
    expect(s.remote.text(note)).toBe(merged);
    // Agreed now: the next round has nothing to do.
    expect(await run(s)).toMatchObject({ uploaded: 0, downloaded: 0, merged: 0 });
  });

  test("keeps both versions of a note when both changed the same words", async () => {
    const s = await setup();
    const note = "Notes/Hallo-ee006b29.md";
    await s.write(note, "# Hallo\n\nDu Kleiner\n");
    await run(s);
    await s.write(note, "# Hallo\n\nDu Großer\n");
    await utimes(join(s.root, note), new Date(), new Date(Date.now() - 60_000));
    s.remote.put(note, "# Hallo\n\nDu Mittlerer\n");

    const result = await run(s);

    expect(result.merged).toBe(0);
    expect(result.conflicts).toEqual([{ path: note, copyPath: "Notes/Hallo-ee006b29 (Anna Muster, 2099-09-25 14.03).md" }]);
  });

  test("brings back a file deleted here that was edited remotely", async () => {
    const s = await setup();
    await s.write("a.txt", "one");
    await run(s);
    await rm(join(s.root, "a.txt"));
    s.remote.put("a.txt", "edited");

    await run(s);

    expect(await s.read("a.txt")).toBe("edited");
    expect(s.remote.text("a.txt")).toBe("edited");
  });

  test("holds back many deletions made here until they are confirmed", async () => {
    const s = await setup();
    for (let index = 0; index < 12; index++) await s.write(`doc-${index}.txt`, String(index));
    await run(s);
    for (let index = 0; index < 12; index++) await rm(join(s.root, `doc-${index}.txt`));

    const held = await run(s);
    expect(held).toMatchObject({ heldDeletions: 12, removedRemote: 0, pending: 12 });
    expect(s.remote.files.size).toBe(12);

    const confirmed = await run(s, { allowDeletions: true });
    expect(confirmed).toMatchObject({ heldDeletions: 0, removedRemote: 12 });
    expect(s.remote.files.size).toBe(0);
  });

  test("a push without listing finds a newer remote version stale and changes nothing", async () => {
    const s = await setup();
    await s.write("a.txt", "one");
    await run(s);
    s.remote.put("a.txt", "theirs");
    await s.write("a.txt", "mine");
    await utimes(join(s.root, "a.txt"), new Date(), new Date(Date.now() - 60_000));

    const result = await run(s, { reconcile: false });

    expect(result).toMatchObject({ stale: true, uploaded: 0 });
    expect(s.remote.text("a.txt")).toBe("theirs");
    expect(await s.read("a.txt")).toBe("mine");
    // The reconcile that follows keeps both.
    expect((await run(s)).conflicts).toHaveLength(1);
  });

  test("never syncs hidden, lock or temporary files, nor what is outside the scope", async () => {
    const s = await setup();
    await s.write(".legalwork/project.json", "{}");
    await s.write(".opencode/opencode.jsonc", "{}");
    await s.write("~$Klage.docx", "lock");
    await s.write("download.crdownload", "partial");
    await s.write("Notes/Privat.md", "private");
    await s.write("Klage.docx", "klage");

    await run(s, { includes: (path) => !path.startsWith("Notes/") });

    expect([...s.remote.files.values()].map((file) => file.path)).toEqual(["Klage.docx"]);
  });

  test("ignores remote paths that would leave the folder, and keeps unsyncable local names here", async () => {
    const s = await setup();
    s.remote.put("../outside.txt", "x");
    s.remote.put("a\\..\\..\\outside.txt", "x");
    s.remote.put("C:/Windows/evil.txt", "x");
    await s.write("Termin 10:00.txt", "local only");

    const result = await run(s);

    expect(result.downloaded).toBe(0);
    expect(await readdir(dirname(s.root))).not.toContain("outside.txt");
    expect(result.skipped).toEqual([{ path: "Termin 10:00.txt", reason: "failed", detail: "unsupported file name" }]);
    expect(s.remote.text("Termin 10:00.txt")).toBeUndefined();
    expect(await s.read("Termin 10:00.txt")).toBe("local only");
  });

  test("waits for a file that is still being written", async () => {
    const s = await setup();
    await s.write("scan.pdf", "half");
    const result = await run(s, { settleMs: 60_000, now: () => new Date() });
    expect(result).toMatchObject({ uploaded: 0, pending: 1 });
    expect(s.remote.files.size).toBe(0);
  });

  test("names conflict copies uniquely", () => {
    const taken = new Set(["Akte/Klage (Anna, 2026-09-25 14.03).pdf"]);
    expect(conflictCopyPath("Akte/Klage.pdf", "Anna", new Date(2026, 8, 25, 14, 3), (path) => taken.has(path))).toBe(
      "Akte/Klage (Anna, 2026-09-25 14.03 2).pdf",
    );
  });
});
