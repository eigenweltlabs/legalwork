import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../types.js";
import { ReviewLibrary, builtinReviewLibrary } from "./library.js";
import { ReviewStore } from "./storage.js";
import { ReviewLibraryEntrySchema, SavedReviewSchema, reviewLibraryKind, reviewLibraryPrompts } from "./schema.js";
import { columnBackend, validateReviewPolicy } from "./policy.js";
import { BUILTIN_JEV_FALLBACKS } from "./builtin-library.js";
import { builtinJevFallback, upgradeBuiltinReviewColumn } from "./builtin-fallback.js";

test("personal prompt versions retain exact text and leave existing project snapshots unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-library-"));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  try {
    const library = new ReviewLibrary(config);
    const first = await library.save({ name: "My own title", language: "de", columns: [{ key: "assign", label: "My label", question: "Is assignment permitted?", kind: "yes_no" }] });
    expect(first.kind).toBe("prompt");
    const singleSet = await library.save({ name: "One-question set", kind: "set", language: "en", columns: first.columns });
    expect(singleSet.kind).toBe("set");
    const savedSet = await library.save({ id: singleSet.id, version: singleSet.version, name: singleSet.name, language: singleSet.language, columns: singleSet.columns });
    expect(savedSet.kind).toBe("set");
    await expect(library.save({ name: "Invalid prompt", kind: "prompt", language: "en", columns: [first.columns[0], { ...first.columns[0], key: "second" }] })).rejects.toThrow("one column");
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
  expect(en.options).toContain("Not found");
  expect(en.options).toContain("Not applicable");
  expect(en.options).toContain("Unclear");
  expect(en.options.length).toBeLessThanOrEqual(30);
  expect(de.options.length).toBe(en.options.length);
  expect(de.options[en.options.indexOf("Germany")]).toBe("Deutschland");
  expect(en.question).toContain("Do not infer");
});

test("every shipped JEV prompt and set offers absence, irrelevance and uncertainty in both languages", () => {
  for (const locale of ["en", "de"] satisfies Array<"en" | "de">) {
    for (const entry of builtinReviewLibrary(locale).filter(entry => entry.tags.includes("jev"))) {
      for (const column of entry.columns) {
        expect(column.kind).toBe("classification");
        for (const fallback of Object.values(BUILTIN_JEV_FALLBACKS[locale])) expect(column.options).toContain(fallback);
        expect(new Set(column.options).size).toBe(column.options.length);
        expect(column.options.length).toBeLessThanOrEqual(30);
        expect(builtinJevFallback(column)).not.toBeNull();
      }
    }
    const binary = builtinReviewLibrary(locale).find(entry => entry.id === `builtin-assignment-${locale}`)!.columns[0];
    expect(binary.options).toEqual(locale === "en" ? ["Yes", "No", "Not found", "Not applicable", "Unclear"] : ["Ja", "Nein", "Nicht gefunden", "Nicht anwendbar", "Unklar"]);
  }
});

test("fallback upgrades recognize exact builtin copies while preserving custom prompts and personal entries", () => {
  for (const locale of ["en", "de"] satisfies Array<"en" | "de">) {
    const old = builtinReviewLibrary(locale, 2).find(entry => entry.id === `builtin-set-nda-${locale}`)!.columns;
    for (const column of old) {
      const copy = { ...column, key: `user-${column.key}`, label: "My display label" };
      const updated = upgradeBuiltinReviewColumn(copy);
      expect(updated.libraryVersion).toBe(3); expect(updated.key).toBe(copy.key); expect(updated.label).toBe(copy.label);
      expect(upgradeBuiltinReviewColumn(updated)).toBe(updated);
      for (const custom of [{ ...copy, question: `${copy.question} Custom question` }, { ...copy, hint: "My own instructions" }, { ...copy, libraryId: randomUUID() }]) {
        expect(upgradeBuiltinReviewColumn(custom)).toBe(custom);
      }
    }
  }
});

test("translated presets preserve column identity, order and answer structure", () => {
  const en = builtinReviewLibrary("en");
  const de = builtinReviewLibrary("de");
  expect(de.length).toBe(en.length);
  for (const [index, entry] of en.entries()) {
    expect(de[index].columns.map(c => [c.key, c.kind, c.options.length])).toEqual(entry.columns.map(c => [c.key, c.kind, c.options.length]));
  }
});

test("sets and All prompts preserve standalone prompts and include questions stored only in sets", () => {
  const entries = builtinReviewLibrary("en");
  const standalone = entries.find(entry => reviewLibraryKind(entry) === "prompt")!;
  const sets = entries.filter(entry => reviewLibraryKind(entry) === "set");
  expect(sets.length).toBeGreaterThan(1);
  const all = reviewLibraryPrompts(entries);
  expect(all).toHaveLength(entries.filter(entry => reviewLibraryKind(entry) === "prompt").length);
  expect(all.some(item => item.sets.length > 1)).toBe(true);
  const custom = { ...sets[0], id: "personal-set", source: "personal", columns: [{ ...standalone.columns[0], question: "A custom question?" }] } satisfies typeof sets[number];
  expect(reviewLibraryPrompts([custom])[0]).toMatchObject({ entry: { id: "personal-set" }, column: { question: "A custom question?" }, sets: [{ id: "personal-set" }] });
  expect(reviewLibraryPrompts([standalone, { ...standalone, id: "copy", source: "personal" }])).toHaveLength(2);
  expect(reviewLibraryPrompts([standalone, { ...standalone, id: "distinct" }])).toHaveLength(2);
  expect(reviewLibraryKind({ columns: standalone.columns })).toBe("prompt");
  expect(reviewLibraryKind({ columns: sets[0].columns })).toBe("set");
});
