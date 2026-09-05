// Render an original and editor round trip with the same office engine/fonts.
// This is a content/pagination gate, not Microsoft Word fidelity certification.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { toProseDoc, fromProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";

const input = resolve(process.argv[2] ?? "scripts/fixtures/legal-review.docx");
const output = resolve(process.argv[3] ?? "docx-interop-output");
const office = process.env.LIBREOFFICE_BIN ?? "libreoffice";
for (const [command, args] of [[office, ["--version"]], ["pdfinfo", ["-v"]], ["pdftotext", ["-v"]]]) {
  try { execFileSync(command, args, { stdio: "pipe", timeout: 15000 }); }
  catch { throw new Error(`Missing ${command}. Install LibreOffice Writer, Poppler and the document's fonts before running this gate.`); }
}
await mkdir(output, { recursive: true });
const bytes = new Uint8Array(await readFile(input)).buffer;
const original = await DocxReviewer.fromBuffer(bytes);
const model = original.toDocument();
const edited = new DocxReviewer(fromProseDoc(toProseDoc(model), model), "Interop test", bytes);
await copyFile(input, join(output, "original.docx"));
await writeFile(join(output, "roundtrip.docx"), new Uint8Array(await edited.toBuffer()));

const report = { input, renderer: execFileSync(office, ["--version"], { encoding: "utf8" }).trim(), results: [] };
for (const name of ["original", "roundtrip"]) {
  execFileSync(office, [`-env:UserInstallation=${pathToFileURL(join(output, "office-profile")).href}`, "--headless", "--convert-to", "pdf", "--outdir", output, join(output, `${name}.docx`)], { stdio: "pipe", timeout: 120000 });
  const pdf = join(output, `${name}.pdf`);
  const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
  const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
  await writeFile(join(output, `${name}.txt`), text);
  report.results.push({ name, pages: Number(info.match(/^Pages:\s+(\d+)/m)?.[1]), text: text.replace(/\s+/g, " ").trim() });
}
const [before, after] = report.results;
report.textMatches = before.text === after.text;
report.pageCountMatches = before.pages > 0 && before.pages === after.pages;
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ textMatches: report.textMatches, pageCountMatches: report.pageCountMatches, output }));
if (!report.textMatches || !report.pageCountMatches) process.exitCode = 1;
