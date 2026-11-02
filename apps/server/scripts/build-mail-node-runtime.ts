import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ? resolve(process.argv[2]) : join(server, "dist/mail-node-runtime");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const [entry, name] of [
  ["runtime/worker.ts", "worker.mjs"],
  ["runtime/maintenance-worker.ts", "maintenance-worker.mjs"],
  ["extraction/process.ts", "process.js"],
]) {
  const result = await Bun.build({
    entrypoints: [join(server, "src/mail", entry)], outdir: output,
    naming: name, target: "node", format: "esm",
    // These packages resolve native binaries, workers or immutable assets by path.
    external: ["better-sqlite3-multiple-ciphers", "tesseract.js", "@tesseract.js-data/*", "pdfjs-dist", "@napi-rs/canvas"],
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not build mail runtime ${name}`);
}
// The extraction subprocess and its worker thread both load this sibling as ESM.
await writeFile(join(output, "package.json"), '{"type":"module"}\n');
const files = [];
for (const name of ["worker.mjs", "maintenance-worker.mjs", "process.js", "package.json"]) {
  const bytes = await readFile(join(output, name));
  files.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
// Keep the manifest inside integrity-protected ASAR, separate from Node's files.
await writeFile(join(dirname(output), "mail-node-runtime.json"), JSON.stringify({ version: 1, files }) + "\n");
console.log("Built mail workers for the bundled Node runtime");
