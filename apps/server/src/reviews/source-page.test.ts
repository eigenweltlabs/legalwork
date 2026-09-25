import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewSourcePage } from "./source-page.js";
import { ReviewResultSchema } from "./schema.js";

test("source preview highlights validated OCR regions and rejects stale or escaped evidence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-source-page-")));
  try {
    const bytes = await readFile(new URL("../ocr/fixtures/bilingual.png", import.meta.url));
    await writeFile(join(root, "contract.png"), bytes);
    const hash = createHash("sha256").update(bytes).digest("hex"), box = { x: .1, y: .1, width: .5, height: .2 };
    await writeFile(join(root, "prepared.json"), JSON.stringify({ version: "review-preparation-1", key: "fixture", file: "contract.png", fileAbs: join(root, "contract.png"), sourceSha256: hash, engine: { id: "fixture", label: "Fixture", model: "fixture", execution: "local" }, pageCount: 1, status: "complete", pages: [{ page: 1, nativeText: "", status: "complete", width: 1000, height: 260, ocr: { text: "Handwritten addition", regions: [{ text: "Handwritten addition", box }] } }] }));
    const result = ReviewResultSchema.parse({ value: "Needs attention", reason: "", citations: [{ page: 1, source: "ocr", quote: "Handwritten addition", regionIds: [0] }], confidence: "low", evidence: "cited", backend: "llm", providerId: "fixture", model: "fixture", requestedModel: "fixture", sourceHash: hash, preparationPath: "prepared.json", prompt: { key: "term", label: "Term", question: "Is the term modified?", kind: "yes_no" }, completedAt: Date.now() });
    const preview = await reviewSourcePage(root, "contract.png", result, 0, new AbortController().signal);
    expect(preview.regions).toEqual([box]); expect(preview.image.startsWith("data:image/png;base64,")).toBe(true); expect(preview.page).toBe(1);
    await expect(reviewSourcePage(root, "contract.png", { ...result, citations: [{ ...result.citations[0], regionIds: [4] }] }, 0, new AbortController().signal)).rejects.toThrow("regions");
    await symlink(tmpdir(), join(root, "outside"));
    await expect(reviewSourcePage(root, "contract.png", { ...result, preparationPath: "outside" }, 0, new AbortController().signal)).rejects.toThrow("Invalid document evidence");
    await writeFile(join(root, "contract.png"), "changed");
    await expect(reviewSourcePage(root, "contract.png", result, 0, new AbortController().signal)).rejects.toThrow("changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
