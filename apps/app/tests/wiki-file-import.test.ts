import { describe, expect, test } from "bun:test";
import { LegalworkServerError } from "../src/app/lib/legalwork-server";
import { importWikiFiles, wikiImportPath, wikiDroppedFiles } from "../src/react-app/domains/wiki/wiki-file-import";
import { classifyOpenTarget } from "../src/react-app/domains/session/artifacts/open-target";

describe("wiki file import", () => {
  test("reads all directory batches, nested paths and empty folders before drag data expires", async () => {
    const document = new File(["binary"], "Brief.pdf");
    const file = { name: document.name, isFile: true, isDirectory: false, file: (success: FileCallback) => success(document) };
    const empty = { name: "Empty", isFile: false, isDirectory: true, createReader: () => ({ readEntries: (success: (entries: never[]) => void) => success([]) }) };
    let batch = 0;
    const folder = { name: "Client", isFile: false, isDirectory: true, createReader: () => ({ readEntries: (success: (entries: (typeof file | typeof empty)[]) => void) => success(batch++ === 0 ? [file] : batch === 2 ? [empty] : []) }) };
    const items = [{ kind: "file", webkitGetAsEntry: () => folder }];
    const promise = wikiDroppedFiles({ items, files: [] });
    items.length = 0;
    expect(await promise).toEqual([{ file: document, path: "Client/Brief.pdf" }, { file: null, path: "Client/Empty" }]);
    expect(batch).toBe(3);
    expect(await wikiDroppedFiles({ items: [], files: [document] })).toEqual([{ file: document, path: "Brief.pdf" }]);
  });

  test("preserves arbitrary binary bytes and folder paths without an extension allowlist", async () => {
    const written = new Map<string, Uint8Array>();
    const client = { changeWikiEntry: async (): Promise<{ ok: true }> => ({ ok: true }), uploadWikiAsset: async (_id: string, path: string, data: ArrayBuffer) => { written.set(path, new Uint8Array(data)); return { path }; } };
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    const names = ["Agreement.docx", "Budget.xlsx", "Report.pdf", "Deck.pptx", "Photo.png", "Notes.md", "config.json", "recording.mp3", "Archive.zip", "custom.weird"];
    const result = await importWikiFiles(client, "wiki", "Matters", names.map(name => ({ file: new File([bytes], name), path: `Client/${name}` })), []);
    expect(result.errors).toEqual([]);
    expect(result.saved).toEqual(names.map(name => `Matters/Client/${name}`));
    for (const value of written.values()) expect(value).toEqual(bytes);
    expect(names.map(name => classifyOpenTarget(name, "file"))).toEqual(["word", "sheet", "pdf", "slides", "image", "markdown", "text", "audio", "external", "external"]);
  });

  test("preserves existing files and retries a concurrent creation collision", async () => {
    const attempted: string[] = [];
    const client = { changeWikiEntry: async (): Promise<{ ok: true }> => ({ ok: true }), uploadWikiAsset: async (_id: string, path: string, _data: ArrayBuffer) => {
      attempted.push(path);
      if (path === "Folder/Brief (3).pdf") throw new LegalworkServerError(409, "wiki_revision_conflict", "Created concurrently");
      return { path };
    } };
    const items = [1, 2].map(() => ({ file: new File(["pdf"], "Brief.pdf"), path: "Brief.pdf" }));
    const result = await importWikiFiles(client, "wiki", "Folder", items, ["Folder/Brief.pdf", "Folder/Brief (2).pdf"]);
    expect(attempted).toEqual(["Folder/Brief (3).pdf", "Folder/Brief (4).pdf", "Folder/Brief (5).pdf"]);
    expect(result.saved).toEqual(["Folder/Brief (4).pdf", "Folder/Brief (5).pdf"]);
    expect(result.errors).toEqual([]);
  });

  test("continues after an invalid or rejected file and does not retry authorization failures", async () => {
    const attempted: string[] = [];
    const client = { changeWikiEntry: async (): Promise<{ ok: true }> => ({ ok: true }), uploadWikiAsset: async (_id: string, path: string, _data: ArrayBuffer) => {
      attempted.push(path);
      if (path === "restricted.docx") throw new LegalworkServerError(403, "forbidden", "No access");
      return { path };
    } };
    const result = await importWikiFiles(client, "wiki", "", ["../outside.md", "restricted.docx", "safe.txt"].map(path => ({ file: new File(["test"], path), path })), []);
    expect(attempted).toEqual(["restricted.docx", "safe.txt"]);
    expect(result.saved).toEqual(["safe.txt"]);
    expect(result.errors).toHaveLength(2);
  });

  test("dashboard collision names preserve the complete file type", async () => {
    const client = { changeWikiEntry: async (): Promise<{ ok: true }> => ({ ok: true }), uploadWikiAsset: async (_id: string, path: string) => ({ path }) };
    const result = await importWikiFiles(client, "wiki", "Dashboards", [{ file: new File(["{}"], "Overview.view.json"), path: "Overview.view.json" }], ["Dashboards/Overview.view.json"]);
    expect(result.saved).toEqual(["Dashboards/Overview (2).view.json"]);
    expect(result.errors).toEqual([]);
  });

  test("rejects paths that escape the wiki or become invisible in its tree", () => {
    for (const path of ["../outside", "/absolute", "a/../../escape", ".hidden", "a/.private/file", "a//b", "a#b", "C:\\file"]) expect(() => wikiImportPath("", path)).toThrow();
    expect(wikiImportPath("Clients", "Müller\\Evidence.pdf")).toBe("Clients/Müller/Evidence.pdf");
    expect(() => wikiImportPath("../outside", "file.txt")).toThrow();
  });
});
