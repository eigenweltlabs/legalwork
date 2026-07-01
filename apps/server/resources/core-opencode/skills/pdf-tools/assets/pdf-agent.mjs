#!/usr/bin/env node
/**
 * pdf-agent — headless PDF actions for the firm's agent: inspect, annotate,
 * fill (AcroForm), sign. Thin CLI over ./pdf-ops.mjs (which imports the vendored
 * ./vendor/pdf-lib.mjs), so it runs in any seeded workspace with NO node_modules.
 *
 * NEVER modifies the source PDF — every command writes a NEW file next to it.
 *
 * Subcommands:
 *
 *   inspect <file.pdf>
 *       Print page count, page sizes (points), and every AcroForm form field
 *       (name / type / current value / options) as JSON. Run this FIRST.
 *
 *   annotate <file.pdf> --plan <plan.json|-> [--out <file>]
 *       Draw sticky notes + highlight rectangles. Writes <base>.annotated.pdf.
 *       Plan: { annotations: [ { type: "note", page, x, y, text, color? },
 *                              { type: "highlight", page, x, y, width, height?, color? } ] }
 *
 *   fill <file.pdf> --data <data.json|-> [--out <file>]
 *       Fill AcroForm fields from { "fieldName": value }. Writes <base>.filled.pdf.
 *
 *   sign <file.pdf> --name "Full Name" [--date YYYY-MM-DD] [--image sig.png]
 *        [--page N] [--x N] [--y N] [--image-width N] [--out <file>]
 *       Stamp a signature block (name + rule + "Signed by ... on ...", or a PNG
 *       signature image). Defaults: last page, bottom-right. Writes <base>.signed.pdf.
 *
 * Pages are 1-based; x/y are PDF points with the origin at the BOTTOM-LEFT.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename, extname } from "node:path";
import { annotatePdf, fillFormFields, inspectPdf, signPdf, PdfOpsError } from "./pdf-ops.mjs";

// ---------- args ----------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message) {
  process.stderr.write(`pdf-agent: ${message}\n`);
  process.exit(1);
}

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function loadSource(file) {
  if (!file) fail("missing <file.pdf> argument");
  const path = resolve(file);
  if (!existsSync(path)) fail(`file not found: ${file}`);
  return { path, bytes: readFileSync(path) };
}

function readJsonFlag(flags, key) {
  if (flags[key] === undefined) fail(`missing --${key} (a JSON file path, or "-" to read it from stdin)`);
  const raw = flags[key] === "-" || flags[key] === true ? readStdin() : readFileSync(resolve(String(flags[key])), "utf8");
  try { return JSON.parse(raw); }
  catch (error) { fail(`could not parse --${key} JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function numberFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  const value = Number(flags[key]);
  if (!Number.isFinite(value)) fail(`--${key} must be a number, got "${flags[key]}"`);
  return value;
}

// Output filenames must be PLAIN (no spaces, parens, etc.) so the app's artifact
// pipeline surfaces them as openable PDF artifacts — a spaced/paren name silently
// fails the filename matcher and never appears as something the user can open.
function plainName(name) {
  return name.replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "document";
}

function resolveOut(source, flags, suffix) {
  const ext = extname(source);
  const out = typeof flags.out === "string"
    ? resolve(flags.out)
    : join(dirname(source), `${plainName(basename(source, ext))}.${suffix}${ext || ".pdf"}`);
  if (out === source) fail("refusing to overwrite the original PDF — pass a different --out path");
  return out;
}

function printResult(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

// ---------- commands ----------

async function cmdInspect(positional) {
  const { path, bytes } = loadSource(positional[0]);
  printResult({ file: path, ...(await inspectPdf(bytes)) });
}

async function cmdAnnotate(positional, flags) {
  const { path, bytes } = loadSource(positional[0]);
  const plan = readJsonFlag(flags, "plan");
  const outPath = resolveOut(path, flags, "annotated");
  const { bytes: outBytes, notes, highlights } = await annotatePdf(bytes, plan);
  writeFileSync(outPath, outBytes);
  printResult({ ok: true, out: outPath, name: basename(outPath), notes, highlights });
}

async function cmdFill(positional, flags) {
  const { path, bytes } = loadSource(positional[0]);
  const data = readJsonFlag(flags, "data");
  const outPath = resolveOut(path, flags, "filled");
  const { bytes: outBytes, filled, skipped } = await fillFormFields(bytes, data);
  writeFileSync(outPath, outBytes);
  printResult({ ok: skipped.length === 0, out: outPath, name: basename(outPath), filled, skipped });
}

async function cmdSign(positional, flags) {
  const { path, bytes } = loadSource(positional[0]);
  let image;
  if (typeof flags.image === "string") {
    const imagePath = resolve(flags.image);
    if (!existsSync(imagePath)) fail(`signature image not found: ${flags.image}`);
    image = readFileSync(imagePath);
  }
  const outPath = resolveOut(path, flags, "signed");
  const { bytes: outBytes, ...placement } = await signPdf(bytes, {
    name: typeof flags.name === "string" ? flags.name : "",
    date: typeof flags.date === "string" ? flags.date : undefined,
    page: numberFlag(flags, "page"),
    x: numberFlag(flags, "x"),
    y: numberFlag(flags, "y"),
    image,
    imageWidth: numberFlag(flags, "image-width"),
  });
  writeFileSync(outPath, outBytes);
  printResult({ ok: true, out: outPath, name: basename(outPath), ...placement });
}

// ---------- main ----------

const { positional, flags } = parseArgs(process.argv.slice(2));
const command = positional.shift();

try {
  if (command === "inspect") await cmdInspect(positional);
  else if (command === "annotate") await cmdAnnotate(positional, flags);
  else if (command === "fill") await cmdFill(positional, flags);
  else if (command === "sign") await cmdSign(positional, flags);
  else fail(`unknown command "${command ?? ""}". Use inspect | annotate | fill | sign.`);
} catch (error) {
  if (error instanceof PdfOpsError) fail(error.message);
  throw error;
}
