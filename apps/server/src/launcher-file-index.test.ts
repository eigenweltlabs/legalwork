import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherFileIndex } from "./launcher-file-index.js";

test("filename search ranks exact, prefix, word, substring and fuzzy matches and skips tool folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-index-"));
  const index = new LauncherFileIndex({ watch: false });
  try {
    await mkdir(join(root, "Müller", "Verträge"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "Müller", "Verträge", "Mietvertrag.docx"), "a");
    await writeFile(join(root, "Müller", "Verträge", "Mietvertrag-alt.docx"), "b");
    await writeFile(join(root, "Müller", "Untermietvertrag.pdf"), "c");
    await writeFile(join(root, "Notizen Vertrag.md"), "d");
    await writeFile(join(root, "node_modules", "pkg", "mietvertrag.js"), "e");
    await writeFile(join(root, ".hidden-mietvertrag.txt"), "f");
    await writeFile(join(root, "6f30a62f-78a1-45ba-98f4-2033336f10e0.view.json"), "{}");
    expect(index.state("w")).toBe("unavailable");
    await index.ensure("w", root, true);
    expect(index.state("w")).toBe("ready");
    expect(index.size("w")).toBe(6);
    expect(index.search("w", "", 20, { browse: true }).filter(item => item.entry.directory).map(item => item.entry.path).sort()).toEqual(["Müller", "Müller/Verträge"]);
    expect(index.search("w", "view.json")).toEqual([]);
    const results = index.search("w", "mietvertrag").map(item => [item.entry.path, item.match]);
    expect(results).toEqual([["Müller/Verträge/Mietvertrag.docx", "exact"], ["Müller/Verträge/Mietvertrag-alt.docx", "prefix"], ["Müller/Untermietvertrag.pdf", "substring"]]);
    const multi = index.search("w", "müller vertrag").filter(item => !item.entry.directory).map(item => item.entry.path);
    expect(multi[0]).toBe("Müller/Verträge/Mietvertrag.docx");
    expect(multi.slice(1).sort()).toEqual(["Müller/Untermietvertrag.pdf", "Müller/Verträge/Mietvertrag-alt.docx"]);
    expect(index.search("w", "vertrag").map(item => item.match)).toContain("word");
    expect(index.search("w", "mvtr").map(item => item.match)).toEqual(["fuzzy", "fuzzy", "fuzzy"]);
    expect(index.search("w", "zzzz")).toEqual([]);
    // A later walk sees the change; keystrokes in between search memory only.
    await writeFile(join(root, "Kaufvertrag.docx"), "g");
    expect(index.search("w", "kaufvertrag")).toEqual([]);
    index.invalidate("w");
    await index.ensure("w", root, true);
    expect(index.search("w", "kaufvertrag")[0]?.entry.name).toBe("Kaufvertrag.docx");
  } finally { index.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("a bounded index reports itself as limited instead of pretending completeness", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-index-limit-"));
  const index = new LauncherFileIndex({ watch: false, maxEntries: 2 });
  try {
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, name), name);
    await index.ensure("w", root, true);
    expect(index.state("w")).toBe("limited");
    expect(index.size("w")).toBe(2);
  } finally { index.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("filters narrow by extension and modification time, and list recent files without words", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-index-filters-"));
  try {
    await mkdir(join(root, "Verträge"), { recursive: true });
    await writeFile(join(root, "Verträge", "Mietvertrag.docx"), "a");
    await writeFile(join(root, "Verträge", "Mietvertrag.pdf"), "b");
    await writeFile(join(root, "Notiz.md"), "c");
    const old = join(root, "Alt.docx");
    await writeFile(old, "d");
    const { utimes } = await import("node:fs/promises");
    await utimes(old, new Date(Date.now() - 90 * 86_400_000), new Date(Date.now() - 90 * 86_400_000));
    const index = new LauncherFileIndex({ watch: false });
    await index.ensure("w", root, true);
    expect(index.search("w", "Mietvertrag", 10, { types: ["pdf"] }).map(match => match.entry.name)).toEqual(["Mietvertrag.pdf"]);
    expect(index.search("w", "", 10, { types: ["docx"] }).map(match => match.entry.name).sort()).toEqual(["Alt.docx", "Mietvertrag.docx"]);
    expect(index.search("w", "", 10, { types: ["docx"], modifiedAfter: Date.now() - 86_400_000 }).map(match => match.entry.name)).toEqual(["Mietvertrag.docx"]);
    expect(index.search("w", "", 10)).toEqual([]);
    expect(index.search("w", "", 10, { browse: true }).map(match => match.entry.name).sort()).toEqual(["Alt.docx", "Mietvertrag.docx", "Mietvertrag.pdf", "Notiz.md", "Verträge"]);
    expect(index.search("w", "", 10, { browse: true }).at(-1)?.entry.name).toBe("Alt.docx");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit sorting chooses from the whole filename index before applying the result limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-sort-"));
  const index = new LauncherFileIndex({ watch: false });
  try {
    for (const [name, time] of [["Contract 10.pdf", 30], ["Contract 2.pdf", 20], ["Agreement.pdf", 10]] satisfies [string, number][]) {
      await writeFile(join(root, name), "x"); await utimes(join(root, name), time, time);
    }
    await index.ensure("w", root, true);
    expect(index.search("w", "", 1, { browse: true, sort: "name-asc" }).map(item => item.entry.name)).toEqual(["Agreement.pdf"]);
    expect(index.search("w", "", 2, { browse: true, sort: "name-desc" }).map(item => item.entry.name)).toEqual(["Contract 10.pdf", "Contract 2.pdf"]);
    expect(index.search("w", "", 1, { browse: true, sort: "recent" }).map(item => item.entry.name)).toEqual(["Contract 10.pdf"]);
    expect(index.search("w", "", 1, { browse: true, sort: "oldest" }).map(item => item.entry.name)).toEqual(["Agreement.pdf"]);
  } finally { index.dispose(); await rm(root, { recursive: true, force: true }); }
});
