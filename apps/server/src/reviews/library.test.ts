import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../types.js";
import { ReviewLibrary, builtinReviewLibrary } from "./library.js";
import { ReviewStore } from "./storage.js";
import { ReviewLibraryEntrySchema, SavedReviewSchema } from "./schema.js";
import { columnBackend, validateReviewPolicy } from "./policy.js";

test("personal prompt versions retain exact text and leave existing project snapshots unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-library-"));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  try {
    const library = new ReviewLibrary(config);
    const first = await library.save({ name: "My own title", language: "de", columns: [{ key: "assign", label: "My label", question: "Is assignment permitted?", kind: "yes_no" }] });
    const store = new ReviewStore(root);
    const review = await store.create(SavedReviewSchema.parse({ id: randomUUID(), name: "Saved review", revision: 0, createdAt: 0, updatedAt: 0, settings: { mode: "jev", jev: { providerId: "firm", model: "jev" }, llm: null }, columns: first.columns, documents: [], cells: [], status: "draft", runId: null }));
    const next = { id: first.id, version: first.version, name: first.name, language: first.language, columns: [{ ...first.columns[0], question: "Is assignment prohibited?" }] };
    const second = await library.save(next);
    expect(second.version).toBe(2);
    expect(second.columns[0].libraryColumnKey).toBe("assign");
    await expect(library.save(next)).rejects.toThrow("changed");
    expect((await store.read(review.id)).columns).toEqual(first.columns);
    for (const locale of ["en", "de"] satisfies Array<"en" | "de">) {
      const found = (await library.list(locale)).find(item => item.id === first.id)!;
      expect(found.name).toBe("My own title");
      expect(found.columns[0].question).toBe("Is assignment prohibited?");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("curated sets have localized prompts and fixed classification choices", () => {
  for (const locale of ["en", "de"] satisfies Array<"en" | "de">) {
    const entries = builtinReviewLibrary(locale);
    expect(entries.some(entry => entry.id === `builtin-set-due-diligence-${locale}`)).toBe(true);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
    for (const entry of entries) {
      expect(ReviewLibraryEntrySchema.safeParse(entry).success).toBe(true);
      for (const column of entry.columns) {
      expect(column.question.length).toBeGreaterThan(10);
      if (column.kind === "classification") expect(column.options.length).toBeGreaterThanOrEqual(2);
      expect(column.libraryId).toBe(entry.id);
      expect(column.libraryVersion).toBe(entry.version);
      }
    }
  }
});

test("every decision preset runs under the enforced Only JEV policy in both languages", () => {
  const settings = { mode: "jev", jev: { providerId: "firm", model: "EigenJev" }, llm: null } satisfies Parameters<typeof validateReviewPolicy>[0];
  for (const locale of ["en", "de"] satisfies Array<"en" | "de">) {
    const entries = builtinReviewLibrary(locale);
    const presets = entries.filter(entry => entry.id.startsWith("builtin-set-") && entry.tags.includes("jev"));
    expect(presets).toHaveLength(12);
    for (const entry of presets) {
      expect(() => validateReviewPolicy(settings, entry.columns)).not.toThrow();
      for (const column of entry.columns) {
        expect(columnBackend("jev", column)).toBe("systemone");
        expect(columnBackend("mixed", column)).toBe("systemone");
        expect(columnBackend("llm", column)).toBe("llm");
      }
    }
    const extraction = entries.find(entry => entry.id === `builtin-set-exact-extraction-${locale}`)!;
    expect(() => validateReviewPolicy(settings, extraction.columns)).toThrow("need an LLM");
    expect(extraction.columns.every(column => columnBackend("mixed", column) === "llm")).toBe(true);
  }
});

test("country decisions include explicit countries and avoid forcing missing or unlisted jurisdictions", () => {
  const en = builtinReviewLibrary("en").find(entry => entry.id === "builtin-governing-law-en")!.columns[0];
  const de = builtinReviewLibrary("de").find(entry => entry.id === "builtin-governing-law-de")!.columns[0];
  expect(en.kind).toBe("classification");
  expect(en.options).toContain("Germany");
  expect(en.options).toContain("United States");
  expect(en.options).toContain("Other country");
  expect(en.options).toContain("Multiple countries");
  expect(en.options).toContain("Not stated");
  expect(en.options).toContain("Unclear");
  expect(en.options.length).toBeLessThanOrEqual(30);
  expect(de.options.length).toBe(en.options.length);
  expect(de.options[en.options.indexOf("Germany")]).toBe("Deutschland");
  expect(en.question).toContain("Do not infer");
});

test("translated presets preserve column identity, order and answer structure", () => {
  const en = builtinReviewLibrary("en");
  const de = builtinReviewLibrary("de");
  expect(de.length).toBe(en.length);
  for (const [index, entry] of en.entries()) {
    expect(de[index].columns.map(c => [c.key, c.kind, c.options.length])).toEqual(entry.columns.map(c => [c.key, c.kind, c.options.length]));
  }
});
