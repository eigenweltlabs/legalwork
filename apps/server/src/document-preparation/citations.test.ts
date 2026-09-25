import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
const builder = fileURLToPath(new URL("../../resources/core-opencode/skills/tabular-review/assets/build-review.mjs", import.meta.url));
const resultSchema = z.object({ rows: z.array(z.object({ cells: z.record(z.string(), z.object({ value: z.string(), evidence: z.string().optional(), confidence: z.string().nullable().optional(), citations: z.array(z.object({ page: z.number(), regions: z.array(z.object({ x: z.number() })) })).optional() })) })) });

test("builder verifies multiple citations, resolves OCR boxes, blocks stale evidence and escapes source markup", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-citations-"));
  try {
    const file = join(root, "source.pdf"), prepared = join(root, "prepared.json");
    const bytes = "fixture-source-bytes"; await writeFile(file, bytes);
    const box = { x: .1, y: .2, width: .6, height: .1 };
    const doc = { version: "review-preparation-1", fileAbs: file, sourceSha256: createHash("sha256").update(bytes).digest("hex"), status: "needs-review", engine: { label: "OCR" }, pageCount: 2, pages: [
      { page: 1, status: "complete", nativeText: "Base term 30 days", ocr: { text: "Addition 60 days", regions: [{ text: "Addition 60 days", box }] } },
      { page: 2, status: "error", nativeText: "", ocr: null },
    ] };
    await writeFile(prepared, JSON.stringify(doc));
    const data = { preparationRequired: true, matter: "</script><script>alert(1)</script>", columns: [], rows: [{ file: "source.pdf", preparationPath: "prepared.json", cells: {
      term: { value: "30 days; note says 60", citations: [{ page: 1, quote: "Base term 30 days", source: "native" }, { page: 1, quote: "Addition 60 days", source: "ocr", regionIds: [0] }] },
      absent: { value: "Not found" },
      fabricated: { value: "90 days", citations: [{ page: 1, quote: "90 days", source: "ocr", regionIds: [0] }] },
      badRegion: { value: "60 days", citations: [{ page: 1, quote: "Addition 60 days", source: "ocr", regionIds: [9] }] },
    } }] };
    const dataPath = join(root, "review.data.json"), out = join(root, "review.html");
    await writeFile(dataPath, JSON.stringify(data));
    execFileSync(process.execPath, [builder, dataPath], { cwd: root });
    const html = await readFile(out, "utf8");
    expect(html).not.toContain("</script><script>alert(1)</script>");
    const json = html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    const result = resultSchema.parse(JSON.parse(json!));
    const cells = result.rows[0]!.cells;
    expect(cells.term!.citations?.length).toBe(2); expect(cells.term!.citations?.[1]?.regions[0]?.x).toBe(.1);
    for (const key of ["absent", "fabricated", "badRegion"]) expect(cells[key]!.value).toBe("Needs review");
    doc.status = "complete"; doc.pages = [doc.pages[0]!]; doc.pageCount = 1;
    await writeFile(prepared, JSON.stringify(doc));
    const decisionData = { ...data, rows: [{ file: "source.pdf", preparationPath: "prepared.json", review: { backend: "systemone" }, cells: {
      term: { value: "95.00% yes", evidence: "uncited", decision: { type: "noul", noul: .95 }, quote: "", page: null, confidence: null },
    } }] };
    await writeFile(dataPath, JSON.stringify(decisionData));
    execFileSync(process.execPath, [builder, dataPath], { cwd: root });
    const decisionHtml = await readFile(out, "utf8");
    const decisionJson = decisionHtml.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    const decision = resultSchema.parse(JSON.parse(decisionJson!)).rows[0]!.cells.term!;
    expect(decision.value).toBe("95.00% yes"); expect(decision.confidence).toBeNull(); expect(decision.citations).toEqual([]);
    await writeFile(file, "changed");
    expect(() => execFileSync(process.execPath, [builder, dataPath], { cwd: root, stdio: "pipe" })).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
