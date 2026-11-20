/**
 * Measures the file finder on a synthetic corpus: index build time and the
 * filename pass per query (p50 / p95). Usage: bun scripts/launcher-bench.ts [files] [queries]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherFileIndex } from "../src/launcher-file-index.js";

const files = Number(process.argv[2] ?? 50_000), rounds = Number(process.argv[3] ?? 200);
const WORDS = ["Mietvertrag", "Kaufvertrag", "Schriftsatz", "Klage", "Protokoll", "Rechnung", "Vollmacht", "Gutachten", "Anlage", "Entwurf", "Mueller", "Schmidt", "Nord", "Huber", "Vergleich"];
const EXT = [".docx", ".pdf", ".md", ".xlsx", ".txt", ".eml"];
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; };

const root = await mkdtemp(join(tmpdir(), "launcher-bench-"));
try {
  const started = performance.now();
  const folders = new Set<string>();
  for (let index = 0; index < files; index++) {
    const folder = join(root, `Akte ${index % 400}`, `Ordner ${index % 7}`);
    if (!folders.has(folder)) { folders.add(folder); await mkdir(folder, { recursive: true }); }
    const name = `${WORDS[index % WORDS.length]} ${WORDS[(index * 7) % WORDS.length]} ${index}${EXT[index % EXT.length]}`;
    await writeFile(join(folder, name), "");
  }
  console.log(`corpus: ${files} files written in ${Math.round(performance.now() - started)} ms`);
  const fileIndex = new LauncherFileIndex({ watch: false });
  const buildStart = performance.now();
  await fileIndex.ensure("bench", root, true);
  console.log(`index: ${fileIndex.size("bench")} entries built in ${Math.round(performance.now() - buildStart)} ms`);
  const queries = ["Miet", "Mietvertrag Mueller", "schrift", "kauf nord", "gutachten 1234", "protokol"];
  const timings: Record<string, number[]> = {};
  for (let round = 0; round < rounds; round++) for (const query of queries) {
    const start = performance.now();
    fileIndex.search("bench", query, 40);
    (timings[query] ??= []).push(performance.now() - start);
  }
  for (const [query, values] of Object.entries(timings)) console.log(`search "${query}": p50 ${percentile(values, 0.5).toFixed(2)} ms, p95 ${percentile(values, 0.95).toFixed(2)} ms over ${values.length} runs`);
  const all = Object.values(timings).flat();
  console.log(`all queries: p50 ${percentile(all, 0.5).toFixed(2)} ms, p95 ${percentile(all, 0.95).toFixed(2)} ms`);
} finally { await rm(root, { recursive: true, force: true }); }
