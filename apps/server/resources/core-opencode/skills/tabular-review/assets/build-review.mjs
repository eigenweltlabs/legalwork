#!/usr/bin/env node
// build-review.mjs — assemble a self-contained tabular-review artifact.
//
// The artifact does NOT embed any PDF. It embeds a pdf.js viewer (fixed size) and, at
// view time, loads each source PDF dynamically from its local file (via the app's file
// bridge in-app, or a direct URL when opened standalone) and highlights the agent's
// quote string on the cited page. So the artifact stays small no matter how many or how
// large the source PDFs are.
//
// It fills three tokens in review-template.html:
//   /*__PDFJS__*/        -> vendor/pdf.min.js        (executes; defines window.pdfjsLib)
//   /*__PDF_WORKER__*/   -> vendor/pdf.worker.min.js (raw text; decoded to a Blob worker)
//   /*__REVIEW_DATA__*/  -> the review JSON
//
// Usage:
//   node build-review.mjs <data.json> [--out file.html] [--template path] [--vendor dir]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCitations } from "./prepare-citations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--template") args.template = argv[++i];
    else if (a === "--vendor") args.vendor = argv[++i];
    else args._.push(a);
  }
  return args;
}

// Make JS safe to drop inside an inline <script> / raw-text <script> element: the only
// sequence the HTML parser reacts to inside a script element is the literal </script>.
const scriptSafe = (js) => js.replace(/<\/(script)/gi, "<\\/$1");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataPath = args._[0];
  if (!dataPath) { console.error("usage: build-review.mjs <data.json> [--out file.html]"); process.exit(2); }

  const dataAbs = resolve(dataPath);
  const data = prepareCitations(JSON.parse(readFileSync(dataAbs, "utf8")));

  const templatePath = args.template ? resolve(args.template) : join(HERE, "review-template.html");
  const vendorDir = args.vendor ? resolve(args.vendor) : join(HERE, "vendor");
  const template = readFileSync(templatePath, "utf8");
  const pdfjs = readFileSync(join(vendorDir, "pdf.min.js"), "utf8");
  const worker = readFileSync(join(vendorDir, "pdf.worker.min.js"), "utf8");

  for (const token of ["/*__PDFJS__*/", "/*__PDF_WORKER__*/", "/*__REVIEW_DATA__*/"]) {
    if (template.indexOf(token) === -1) { console.error(`template ${templatePath} is missing ${token}`); process.exit(2); }
  }

  // Order matters: inject the (large) library blobs first, JSON last. Use replacer
  // functions so `$` sequences in the payloads are not treated as replacement patterns.
  const html = template
    .replace("/*__PDFJS__*/", () => scriptSafe(pdfjs))
    .replace("/*__PDF_WORKER__*/", () => scriptSafe(worker))
    .replace("/*__REVIEW_DATA__*/", () => JSON.stringify(data).replace(/</g, "\\u003c"));

  const out = args.out ? resolve(args.out) : dataAbs.replace(/\.data\.json$/i, ".html").replace(/\.json$/i, ".html");
  writeFileSync(out, html, "utf8");

  const cited = (data.rows || []).reduce((n, r) => n + Object.values(r.cells || {}).filter((c) => c && c.quote && c.page).length, 0);
  console.log(`✓ wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, fixed-size viewer)`);
  console.log(`  ${(data.rows || []).length} documents, ${cited} cited cells. PDFs load dynamically from disk — nothing embedded.`);
  if (!existsSync(join(vendorDir, "pdf.min.js"))) console.warn("! vendor/pdf.min.js missing — the viewer will not work.");
}

main();
