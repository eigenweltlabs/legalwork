// Controller-only synthetic website. Never copy this code, traces or suite to
// the app account. Only ordinary website/document responses cross the boundary.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateWrite } from "./private-write.mjs";

const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { PDFDocument, StandardFonts } = require("pdf-lib");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export const REGISTER_URL = "http://127.0.0.1:39183/register";
export const registerEntity = "Brackenridge Clinic Network Ltd";
export const registerAgreement = "Clinical archive storage";
export const registerAsOf = "2026-10-24";

export const registerRows = [
  { id: "REG-2024-11", entity: registerEntity, agreement: registerAgreement, status: "executed", signed: "2024-10-18", effective: "2024-11-01", notice: 45, cap: 4, exception: "The supplier may increase charges above the cap when general operating costs increase." },
  { id: "REG-2026-27", entity: registerEntity, agreement: registerAgreement, status: "executed", signed: "2026-09-12", effective: "2026-10-01", notice: 75, cap: 2.5, exception: "The annual increase cap may be exceeded only to the extent strictly required by a binding order of the competent healthcare regulator, with a copy of that order supplied to the customer." },
  { id: "REG-2026-35", entity: registerEntity, agreement: registerAgreement, status: "executed", signed: "2026-10-20", effective: "2027-01-01", notice: 120, cap: 1, exception: "There is no exception to the annual increase cap." },
  { id: "REG-2026-31", entity: registerEntity, agreement: registerAgreement, status: "draft", signed: null, effective: "2026-10-01", notice: 21, cap: 5, exception: "The supplier may exceed the cap in any commercial emergency." },
  { id: "REG-2026-28", entity: "Brackenridge Laboratories Ltd", agreement: registerAgreement, status: "executed", signed: "2026-09-14", effective: "2026-10-01", notice: 90, cap: 10, exception: "The supplier may exceed the cap for changes in any applicable law." },
];

export function registerDocumentText(row) {
  return [
    "SYNTHETIC CONTRACT RECORD - no real client or personal data.",
    `Document: ${row.id}`,
    `Customer: ${row.entity}`,
    `Agreement: ${row.agreement}`,
    `Status: ${row.status}; signed: ${row.signed ?? "not signed"}; effective: ${row.effective}.`,
    `Clause 1. From ${row.effective}, renewal requires ${row.notice} calendar days' notice. This clause replaces any earlier renewal notice clause for this customer and agreement.`,
    `Clause 2. The annual increase in storage charges must not exceed ${row.cap} percent.`,
    `Clause 3. ${row.exception}`,
    row.status === "executed" ? "Executed by both parties. All other terms remain unchanged." : "UNSIGNED DRAFT - not binding and not executed by either party.",
  ];
}

export async function makeRegisterPdf(row) {
  const document = await PDFDocument.create();
  const epoch = new Date("2026-10-24T00:00:00Z");
  document.setCreationDate(epoch); document.setModificationDate(epoch);
  document.setTitle(`${row.id} - ${row.agreement}`);
  document.setAuthor("LegalWork synthetic fixture"); document.setProducer("LegalWork synthetic fixture");
  document.setCreator("LegalWork synthetic fixture");
  const font = await document.embedFont(StandardFonts.Helvetica);
  let page = document.addPage([595, 842]), y = 790;
  for (const paragraph of registerDocumentText(row)) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, 11) > 495 && line) {
        if (y < 60) { page = document.addPage([595, 842]); y = 790; }
        page.drawText(line, { x: 50, y, size: 11, font }); y -= 16; line = word;
      } else line = next;
    }
    if (y < 60) { page = document.addPage([595, 842]); y = 790; }
    page.drawText(line, { x: 50, y, size: 11, font }); y -= 26;
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

export function filterRegister(rows, parameters) {
  const entity = parameters.get("entity") ?? "", agreement = parameters.get("agreement") ?? "";
  const status = parameters.get("status") ?? "", asOf = parameters.get("as_of") ?? "";
  return rows.filter(row => (!entity || row.entity === entity) && (!agreement || row.agreement === agreement)
    && (!status || row.status === status) && (!asOf || row.effective <= asOf));
}

function page(body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic contract register</title><style>body{font:16px system-ui;max-width:1050px;margin:32px auto;padding:0 24px;color:#18263a}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:7px}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{padding:12px;text-align:left;border:1px solid #ccd3db}a{color:#174f99}</style><body><h1>Synthetic contract register</h1><p>Training records only. No real client information.</p>${body}</body></html>`;
}

function registerPage(rows, parameters) {
  const options = (name, values) => values.map(value => `<option value="${escape(value)}"${parameters.get(name) === value ? " selected" : ""}>${escape(value)}</option>`).join("");
  const filtered = filterRegister(rows, parameters);
  return page(`<form action="/register" method="get"><label>Entity <select name="entity" id="entity"><option value="">All entities</option>${options("entity", [...new Set(rows.map(row => row.entity))])}</select></label><label>Agreement <select name="agreement" id="agreement"><option value="">All agreements</option>${options("agreement", [registerAgreement])}</select></label><label>Executed status <select name="status" id="status"><option value="">All statuses</option>${options("status", ["executed", "draft"])}</select></label><label>In force on date <input name="as_of" id="as-of" type="date" value="${escape(parameters.get("as_of") ?? "")}"></label><button type="submit">Apply filters</button></form><p role="status">${filtered.length} records match the current filters.</p><table><thead><tr><th>Record</th><th>Entity</th><th>Agreement</th><th>Status</th><th>Signed</th><th>Effective</th></tr></thead><tbody>${filtered.map(row => `<tr><td><a href="/record/${row.id}">${row.id}</a></td><td>${escape(row.entity)}</td><td>${escape(row.agreement)}</td><td>${row.status}</td><td>${row.signed ?? "not signed"}</td><td>${row.effective}</td></tr>`).join("")}</tbody></table>`);
}

export async function startBrowserRegister({ directory, traces = join(directory, "fixture-traces"), port = 39183 }) {
  const root = resolve(directory);
  const rows = JSON.parse(await readFile(join(root, "site-source.json"), "utf8"));
  const documents = new Map();
  for (const row of rows) documents.set(row.id, await readFile(join(root, "site-documents", `${row.id}.pdf`)));
  await mkdir(traces, { recursive: true, mode: 0o700 });
  const records = [], pending = new Set(), instanceID = randomUUID(); let traceError = null;
  const server = createServer(async (request, response) => {
    let finished;
    const task = new Promise(accept => { finished = accept; }); pending.add(task);
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      let status = 200, mime = "text/html; charset=utf-8", disposition;
      let bytes;
      const id = /^\/(?:record|attachment)\/(REG-\d{4}-\d{2})(?:\.pdf)?$/.exec(url.pathname)?.[1];
      const row = rows.find(item => item.id === id);
      if (request.method !== "GET") { status = 405; bytes = Buffer.from("GET required"); mime = "text/plain"; }
      else if (url.pathname === "/register") bytes = Buffer.from(registerPage(rows, url.searchParams));
      else if (row && url.pathname === `/record/${id}`) bytes = Buffer.from(page(`<h2>${id}</h2><dl><dt>Entity</dt><dd>${escape(row.entity)}</dd><dt>Agreement</dt><dd>${escape(row.agreement)}</dd><dt>Status</dt><dd>${row.status}</dd><dt>Signed</dt><dd>${row.signed ?? "not signed"}</dd><dt>Effective</dt><dd>${row.effective}</dd></dl><a href="/attachment/${id}.pdf" download="${id}-executed-storage-amendment.pdf">Download attachment</a><p><a href="/register">Back to register</a></p>`));
      else if (row && url.pathname === `/attachment/${id}.pdf`) {
        bytes = documents.get(id); mime = "application/pdf"; disposition = `attachment; filename="${id}-executed-storage-amendment.pdf"`;
      } else { status = 404; bytes = Buffer.from("Not found"); mime = "text/plain"; }
      const identity = randomUUID();
      const record = { id: identity, fixtureInstanceID: instanceID, requestedAt: new Date().toISOString(), method: request.method, path: url.pathname,
        query: Object.fromEntries(url.searchParams), headers: request.headers, status, mime,
        responseBytes: bytes.length, responseSha256: hash(bytes), rowID: row?.id ?? null,
        ...(url.pathname === "/register" ? { selectedRows: filterRegister(rows, url.searchParams).map(item => item.id) } : {}),
        deliveryCompleted: false };
      await privateWrite(join(traces, `${identity}.response`), bytes);
      records.push(record);
      const delivered = new Promise(accept => { response.once("finish", () => { record.deliveryCompleted = true; accept(); }); response.once("close", accept); });
      response.writeHead(status, { "Content-Type": mime, "Content-Length": bytes.length, "Cache-Control": "no-store", ...(disposition ? { "Content-Disposition": disposition } : {}) });
      response.end(bytes); await delivered;
      await privateWrite(join(traces, `${identity}.receipt.json`), record);
    } catch (error) {
      traceError = String(error);
      if (!response.headersSent) response.writeHead(500);
      response.end("Synthetic fixture failed; controller review required");
    } finally { finished(); pending.delete(task); }
  });
  // No new request/result/body/task deadline or size ceiling.
  server.requestTimeout = 0; server.headersTimeout = 0; server.timeout = 0;
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
  return { instanceID, url: `http://127.0.0.1:${server.address().port}/register`, records,
    snapshot: async () => { await Promise.all([...pending]); if (traceError) throw new Error(traceError); return structuredClone(records); },
    close: async () => { await new Promise((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); }); await Promise.all([...pending]); if (traceError) throw new Error(traceError); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--fixture");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--fixture <controller-only-directory> is required");
  const server = await startBrowserRegister({ directory: process.argv[index + 1] });
  console.log(JSON.stringify({ listening: server.url, fixtureInstanceID: server.instanceID, inferenceCalls: 0 }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); });
}
