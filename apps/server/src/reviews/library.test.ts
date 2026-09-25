import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../types.js";
import { ReviewLibrary, builtinReviewLibrary } from "./library.js";
import { ReviewStore } from "./storage.js";
import { SavedReviewSchema } from "./schema.js";

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
    for (const entry of entries) for (const column of entry.columns) {
      expect(column.question.length).toBeGreaterThan(10);
      if (column.kind === "classification") expect(column.options.length).toBeGreaterThanOrEqual(2);
    }
  }
});
