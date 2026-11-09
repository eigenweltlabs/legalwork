import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { renderRisHtmlPdf } from "../electron/ris-pdf.mjs";
import { reserveDownload } from "../electron/browser-downloads.mjs";
import { resolveBrowserProject } from "../electron/browser-project.mjs";

const temporary = mkdtempSync(path.join(tmpdir(), "legalwork-ris-pdf-render-"));
app.setPath("userData", path.join(temporary, "profile"));
app.whenReady().then(async () => {
app.dock?.hide();
// Keep the test host alive when each disposable print window is destroyed.
const host = new BrowserWindow({ show: false });
let requests = 0;
const server = createServer((_request, response) => { requests++; response.end("unexpected request"); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const sourceUrl = "https://ogd.ris.bka.gv.at/Dokumente/Vwgh/JWT_2026090005_20260610J00/JWT_2026090005_20260610J00.html";
try {
  await assert.rejects(renderRisHtmlPdf({ html: "<p>invalid source</p>", sourceUrl: "https://example.test/source.html", title: "invalid" }, new AbortController().signal), /official RIS/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(renderRisHtmlPdf({ html: "<p>cancelled</p>", sourceUrl, title: "cancelled" }, controller.signal), { name: "AbortError" });
  const document = { sourceUrl, title: "RIS source rendering regression", html: `<html><head><style>p { font-size: 12pt; }</style></head><body><h1>Original RIS source: Änderung, § 1</h1><p>First paragraph stays intact.</p><table><tr><td>Original table cell</td></tr></table><script>fetch('http://127.0.0.1:${address.port}/script')</script><img src="http://127.0.0.1:${address.port}/image"><iframe src="file:///etc/passwd"></iframe><p>Final paragraph stays intact.</p></body></html>` };
  const pdf = await renderRisHtmlPdf(document, new AbortController().signal);
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString(), "%PDF-");
  assert(pdf.length > 1000);
  assert.equal(requests, 0, "Source scripts and non-RIS resources must not access the network");
  assert.equal(BrowserWindow.getAllWindows().length, 1, "Disposable print windows must be destroyed");
  const { risPdfDownload } = await import("../../server/dist/extensions/ris-pdf.js");
  const engine = path.join(temporary, "engine"), content = path.join(temporary, "documents");
  await mkdir(engine); await mkdir(content);
  const workspace = { id: "ws", name: "PDF parity", path: engine, contentPath: content, preset: "starter", workspaceType: "local" };
  const browserRoot = await resolveBrowserProject({ directory: engine }, { workspaces: [workspace] }, { running: false }, "");
  const browserFile = reserveDownload(browserRoot, "Browser-file.pdf");
  const savePdf = await risPdfDownload({ readOnly: false, workspaces: [workspace], authorizedRoots: [engine], renderHtmlPdf: renderRisHtmlPdf }, { directory: engine }, new AbortController().signal);
  const risFile = await savePdf({ ...document, filename: "RIS-file.pdf" });
  assert.equal(path.dirname(risFile.path), path.dirname(browserFile.path), "RIS and browser downloads must use the exact same canonical directory");
  assert.equal(path.dirname(risFile.path), path.join(await realpath(content), "Downloads"));
  console.log("RIS and browser download paths match:", path.dirname(risFile.path));
  // Optional local output lets manual QA inspect either the fixture or a
  // complete fetched RIS source without putting PDFs/screenshots in Git.
  if (process.argv[2]) {
    const html = process.argv[3] ? await readFile(process.argv[3], "utf8") : document.html;
    await writeFile(path.resolve(process.argv[2]), await renderRisHtmlPdf({ ...document, html }, new AbortController().signal));
  }
  console.log("RIS PDF render passed: PDF bytes, isolated resources, cancellation, and window cleanup.");
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
  host.destroy();
  app.exit(process.exitCode ?? 0);
}
}).catch(error => { console.error(error); app.exit(1); });
