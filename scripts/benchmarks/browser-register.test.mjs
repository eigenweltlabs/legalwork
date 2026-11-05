import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { prepareBrowserRegister } from "./prepare-browser-register.mjs";
import { filterRegister, makeRegisterPdf, registerRows, registerEntity, registerAgreement, registerAsOf, startBrowserRegister } from "./browser-register-fixture.mjs";
import { browserDownloadKey, evaluateBrowserRegisterExecution } from "./browser-register-evidence.mjs";
import { evaluateAssertions } from "./evidence.mjs";

const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { PDFDocument } = require("pdf-lib");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const query = { entity: registerEntity, agreement: registerAgreement, status: "executed", as_of: registerAsOf };

test("filters retain the old and current executed records, excluding future, unsigned and other-company records", () => {
  assert.deepEqual(filterRegister(registerRows, new URLSearchParams(query)).map(row => row.id), ["REG-2024-11", "REG-2026-27"]);
  assert.equal(filterRegister(registerRows, new URLSearchParams({ ...query, entity: "Brackenridge Laboratories Ltd" }))[0].notice, 90);
  assert.deepEqual(filterRegister(registerRows, new URLSearchParams({ ...query, status: "draft" })).map(row => row.id), ["REG-2026-31"]);
  assert.ok(filterRegister(registerRows, new URLSearchParams({ ...query, as_of: "2027-01-01" })).some(row => row.id === "REG-2026-35"));
});

test("PDFs are valid, deterministic and document-specific", async () => {
  const row = registerRows.find(item => item.id === "REG-2026-27");
  const first = await makeRegisterPdf(row), second = await makeRegisterPdf(row);
  assert.deepEqual(first, second);
  const document = await PDFDocument.load(first);
  assert.equal(document.getTitle(), "REG-2026-27 - Clinical archive storage");
  assert.equal(document.getPageCount(), 1);
  assert.notEqual(sha(first), sha(await makeRegisterPdf(registerRows[0])));
});

test("real loopback HTTP serves filters, selected page and exact downloadable PDF, never controller files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lw-browser-fixture-"));
  let server;
  try {
    const fixture = await prepareBrowserRegister(join(parent, "new"));
    await assert.rejects(prepareBrowserRegister(join(parent, "new")), { code: "EEXIST" });
    server = await startBrowserRegister({ directory: fixture.root, port: 0 });
    const origin = new URL(server.url).origin;
    const response = await fetch(`${server.url}?${new URLSearchParams(query)}`), html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes("2 records match"));
    assert.ok(html.includes('href="/record/REG-2026-27"'));
    assert.ok(!html.includes('href="/record/REG-2026-35"'));
    assert.ok(!html.includes('href="/record/REG-2026-31"'));
    assert.ok(!html.includes('href="/record/REG-2026-28"'));
    assert.ok((await (await fetch(`${origin}/record/REG-2026-27`)).text()).includes("Download attachment"));
    const attachment = await fetch(`${origin}/attachment/REG-2026-27.pdf`);
    assert.equal(attachment.headers.get("content-disposition"), 'attachment; filename="REG-2026-27-executed-storage-amendment.pdf"');
    const bytes = Buffer.from(await attachment.arrayBuffer());
    assert.deepEqual(bytes, await readFile(join(fixture.root, "site-documents", "REG-2026-27.pdf")));
    assert.equal(sha(bytes), fixture.documents.find(file => file.rowID === "REG-2026-27").sha256);
    for (const path of ["/suite.json", "/site-source.json", "/source-provenance.json", "/fixture-traces", "/attachment/../../suite.json"]) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404);
    }
    const notAllowed = await fetch(server.url, { method: "POST", body: "untrusted input" });
    assert.equal(notAllowed.status, 405); await notAllowed.text();
    const records = await server.snapshot();
    assert.ok(records.every(record => record.fixtureInstanceID === server.instanceID));
    assert.equal(records.filter(record => record.status === 200).length, 3);
    const download = records.find(record => record.mime === "application/pdf");
    assert.equal(download.deliveryCompleted, true); assert.equal(download.responseSha256, sha(bytes));
    assert.equal(records.find(record => record.path === "/register").query.entity, registerEntity);
    assert.equal(fixture.suite.tasks[0].prompt.includes("75 calendar"), false);
    assert.equal(fixture.suite.tasks[0].prompt.includes("binding order of the competent"), false);
  } finally { if (server) await server.close(); await rm(parent, { recursive: true, force: true }); }
});

function evidenceFixture(native = false) {
  const url = "http://127.0.0.1:39183/register", origin = new URL(url).origin;
  const assertion = { url, entity: registerEntity, agreement: registerAgreement, asOf: registerAsOf,
    rowID: "REG-2026-27", filename: "REG-2026-27-executed-storage-amendment.pdf", bytes: 12345, sha256: sha(Buffer.alloc(12345, 0x5a)) };
  const filtered = `${url}?${new URLSearchParams(query)}`, selected = `${origin}/record/${assertion.rowID}`;
  const sessionID = "owned-session", tabID = "tab_7a6c0b75-c6bb-4a4b-9400-67a39efa3a31", capability = "http://127.0.0.1:43210/private-tab-capability";
  const summary = { tools: [] }, toolExecutions = [];
  const toolIdentityMapping = [
    { id: "browser_tabs_open", qualifiedName: "browser.tabs.open" },
    { id: "browser_navigate", qualifiedName: "browser.navigate" },
    { id: "browser_snapshot", qualifiedName: "browser.snapshot" },
    { id: "browser_files_list", qualifiedName: "browser.files.list" },
    { id: "browser_files_get", qualifiedName: "browser.files.get" },
  ];
  let sequence = 0;
  function add(tool, input, value) {
    const callID = `call-${sequence + 1}`, messageID = `message-${sequence + 1}`;
    if (native) summary.tools.push({ protocol: "native-v2", tool: "execute", sessionID, callID, messageID,
      state: { status: "completed", input: { code: "actual code is not evidence" }, content: [{ type: "text", text: "Done" }], metadata: { toolCalls: [{ tool, input, status: "completed" }] } } });
    else summary.tools.push({ protocol: "legacy-v1", tool, sessionID, callID, messageID,
      state: { status: "completed", input, output: JSON.stringify(value) } });
    toolExecutions.push({ phase: "after", status: "completed", sessionID, ...(native ? { messageID } : {}), callID,
      toolID: native ? toolIdentityMapping.find(item => item.qualifiedName === tool).id : tool, input,
      observerInstance: "root-owned-observer", sequence: ++sequence, recordSha256: "b".repeat(64),
      result: { output: native ? value : JSON.stringify(value) } });
  }
  if (native) {
    add("browser.tabs.open", { url }, { id: tabID, url });
    add("browser.navigate", { tabID, url: filtered }, { id: tabID, url: filtered });
    add("browser.snapshot", { tabID }, { tab: { id: tabID, url: selected }, text: "Selected amendment" });
    add("browser.files.list", { tabID }, { tab: { id: tabID, url: selected }, files: [{ id: "file-one", name: assertion.filename, bytes: assertion.bytes, state: "completed" }] });
    add("browser.files.get", { tabID, fileID: "file-one" }, { tab: { id: tabID, url: selected }, files: [{ id: "file-one", name: assertion.filename, bytes: assertion.bytes, path: "/case/Downloads/source.pdf" }] });
  } else {
    add("legalwork_browser_open_url", { url }, { ok: true, result: { tab_id: tabID, browser_url: capability, url } });
    add("legalwork_browser_batch", { browser_url: capability, steps: [{ type: "click", selector: "button" }] }, { url: filtered, snapshot: {} });
    add("legalwork_browser_batch", { browser_url: capability, steps: [{ type: "click", selector: "a" }] }, { url: selected, snapshot: {} });
    add("legalwork_browser_downloads", { browser_url: capability }, { downloads: [{ id: "file-one", name: assertion.filename, state: "completed", receivedBytes: assertion.bytes, totalBytes: assertion.bytes, path: "/case/Downloads/source.pdf", error: null }] });
  }
  const requests = [
    { id: "filter-request", method: "GET", status: 200, deliveryCompleted: true, path: "/register", query, selectedRows: ["REG-2024-11", assertion.rowID] },
    { id: "selected-request", method: "GET", status: 200, deliveryCompleted: true, path: `/record/${assertion.rowID}`, rowID: assertion.rowID },
    { id: "download-request", method: "GET", status: 200, deliveryCompleted: true, path: `/attachment/${assertion.rowID}.pdf`, rowID: assertion.rowID, responseBytes: assertion.bytes, responseSha256: assertion.sha256, mime: "application/pdf" },
  ];
  requests.forEach(record => { record.fixtureInstanceID = "arm-owned-fixture"; });
  const context = { ownedSessionIDs: [sessionID], toolExecutions, toolIdentityMapping, browserRegisterRequests: requests, browserFixtureInstanceID: "arm-owned-fixture" };
  const candidates = evaluateBrowserRegisterExecution(assertion, summary, context).evidence.completedOwnedDownloads;
  context.browserDownloadReceipts = candidates.map(candidate => ({ key: browserDownloadKey(candidate), sourcePath: candidate.file.path,
    method: "actual-app-uid-no-follow-file-bytes", acquisition: { uid: 1002, expectedUID: 1002, regularFile: true, noSymlinks: true, scope: "workspace-downloads" },
    contentBase64: Buffer.alloc(assertion.bytes, 0x5a).toString("base64"), collectedFile: "/private/controller/actual-download" }));
  return { assertion, summary, context };
}

for (const native of [false, true]) {
  test(`${native ? "native" : "v1"} browser evidence survives actual message normalization and assertion dispatch`, async () => {
    const example = evidenceFixture(native);
    const messages = example.summary.tools.map(call => native
      ? { id: call.messageID, sessionID: call.sessionID, type: "assistant", content: [{ type: "tool", name: call.tool, id: call.callID, state: call.state }] }
      : { info: { id: call.messageID, sessionID: call.sessionID, role: "assistant" }, parts: [{ type: "tool", tool: call.tool, callID: call.callID, state: call.state }] });
    const [result] = await evaluateAssertions([{ ...example.assertion, id: "browser", type: "capability.browser_register" }], "/unused", messages, {}, example.context);
    assert.equal(result.passed, true);
  });
  test(`${native ? "native Code Mode" : "v1 extensions"} requires owned actual results, observed pages and complete download`, () => {
    const example = evidenceFixture(native);
    const result = evaluateBrowserRegisterExecution(example.assertion, example.summary, example.context);
    assert.equal(result.passed, true); assert.equal(result.evidence.completedOwnedDownloads.length, 1);
  });
  for (const [label, change] of [
    ["metadata without observer results", example => { example.context.toolExecutions = []; }],
    ["another session's observer", example => { example.context.toolExecutions.forEach(event => { event.sessionID = "unowned-session"; }); }],
    ["another invocation's observer", example => { example.context.toolExecutions.forEach(event => { event.callID = "wrong-call"; }); }],
    ["missing root record identity", example => { example.context.toolExecutions.forEach(event => { delete event.recordSha256; }); }],
    ["claimed code with no browser calls", example => { example.summary.tools = []; }],
    ["missing real website trace", example => { delete example.context.browserRegisterRequests; }],
    ["another arm's website receipt", example => { example.context.browserRegisterRequests[0].fixtureInstanceID = "other-arm"; }],
    ["no actual returned-path bytes", example => { example.context.browserDownloadReceipts = []; }],
    ["same-length different downloaded bytes despite a correct copied artifact", example => { example.context.browserDownloadReceipts[0].contentBase64 = Buffer.alloc(example.assertion.bytes, 0x21).toString("base64"); }],
    ["actual bytes from a different path", example => { example.context.browserDownloadReceipts[0].sourcePath = "/case/not-the-download.pdf"; }],
    ["incorrect attachment bytes", example => { example.context.browserRegisterRequests[2].responseSha256 = "c".repeat(64); }],
    ["incomplete HTTP delivery", example => { example.context.browserRegisterRequests[2].deliveryCompleted = false; }],
    ["unfiltered register", example => { example.context.browserRegisterRequests[0].query = {}; }],
    ["no observed selected page", example => { example.context.toolExecutions.forEach(event => {
      if (typeof event.result.output === "string") event.result.output = event.result.output.replaceAll("/record/REG-2026-27", "/register");
      else if (event.result.output.tab) event.result.output.tab.url = example.assertion.url;
    }); }],
    ["failed download service", example => { example.context.toolExecutions.at(-1).result = { output: { ok: false, error: "Transfer refused" } }; }],
    ["mismatched returned file", example => {
      const event = example.context.toolExecutions.at(-1);
      if (native) event.result.output.files[0].name = "wrong.pdf";
      else event.result.output = JSON.stringify({ downloads: [{ id: "file-one", name: "wrong.pdf", state: "completed", receivedBytes: example.assertion.bytes, totalBytes: example.assertion.bytes, path: "/case/Downloads/wrong.pdf" }] });
    }],
  ]) test(`${native ? "native" : "v1"} rejects ${label}`, () => {
    const example = evidenceFixture(native); change(example);
    assert.equal(evaluateBrowserRegisterExecution(example.assertion, example.summary, example.context).passed, false);
  });
}

test("native browser rejects a different returned tab and a listing observed only after transfer", () => {
  const wrongTab = evidenceFixture(true);
  wrongTab.context.toolExecutions.at(-1).result.output.tab.id = "tab-other";
  assert.equal(evaluateBrowserRegisterExecution(wrongTab.assertion, wrongTab.summary, wrongTab.context).passed, false);
  const wrongOrder = evidenceFixture(true);
  wrongOrder.context.toolExecutions.at(-2).sequence = 100;
  assert.equal(evaluateBrowserRegisterExecution(wrongOrder.assertion, wrongOrder.summary, wrongOrder.context).passed, false);
});

test("real V1 hook message-ID absence is explicit and ambiguous persisted keys fail closed", () => {
  const example = evidenceFixture();
  assert.ok(example.context.toolExecutions.every(event => event.messageID === undefined));
  const result = evaluateBrowserRegisterExecution(example.assertion, example.summary, example.context);
  assert.equal(result.passed, true);
  assert.equal(result.evidence.observedBrowserCalls[0].observer.rawMessageID, null);
  assert.equal(result.evidence.observedBrowserCalls[0].observer.messageBinding, "unique-owned-call-tool-input-v1-public-hook-omits-messageID");
  example.summary.tools.push({ ...example.summary.tools[0], messageID: "second-message-with-reused-call-key" });
  assert.equal(evaluateBrowserRegisterExecution(example.assertion, example.summary, example.context).passed, false);
});

test("native qualified names require the exact unique catalog mapping, never guessed normalization", () => {
  const missing = evidenceFixture(true); missing.context.toolIdentityMapping = [];
  assert.equal(evaluateBrowserRegisterExecution(missing.assertion, missing.summary, missing.context).passed, false);
  const ambiguous = evidenceFixture(true);
  ambiguous.context.toolIdentityMapping.push({ id: "browser_tabs_open", qualifiedName: "browser.unrelated_open" });
  assert.equal(evaluateBrowserRegisterExecution(ambiguous.assertion, ambiguous.summary, ambiguous.context).passed, false);
  const missingMessage = evidenceFixture(true);
  missingMessage.context.toolExecutions.forEach(event => { delete event.messageID; });
  assert.equal(evaluateBrowserRegisterExecution(missingMessage.assertion, missingMessage.summary, missingMessage.context).passed, false);
  const unrelatedIDs = evidenceFixture(true);
  unrelatedIDs.context.toolIdentityMapping.forEach((item, index) => {
    unrelatedIDs.context.toolExecutions[index].toolID = `catalog-native-id-${index}`;
    item.id = `catalog-native-id-${index}`;
  });
  assert.equal(evaluateBrowserRegisterExecution(unrelatedIDs.assertion, unrelatedIDs.summary, unrelatedIDs.context).passed, true);
});

test("the real assertion dispatcher fails closed without owned browser/service evidence", async () => {
  const example = evidenceFixture();
  const [result] = await evaluateAssertions([{ ...example.assertion, id: "browser", type: "capability.browser_register" }], "/unused", [], {}, example.context);
  assert.equal(result.passed, false);
  assert.ok(result.evidence.fullAttachmentRequests.includes("download-request"));
  assert.deepEqual(result.evidence.completedOwnedDownloads, []);
});
