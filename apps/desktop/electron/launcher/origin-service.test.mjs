import assert from "node:assert/strict";
import { test } from "node:test";
import { OriginService, originMatches, parseHelperJson } from "./origin-service.mjs";

function service(platform, responses, pasteResult = { pasted: true, copied: true, error: null }) {
  const calls = [];
  const clipboard = { text: "previous", readText: () => clipboard.text, writeText: text => { clipboard.text = text; } };
  return { calls, clipboard, service: new OriginService({ platform, helperPath: "/helper", exists: () => true, exec: async (command, args) => { calls.push([command, ...args]); const next = responses.shift(); if (next instanceof Error) throw next; return next ?? ""; }, clipboard, pasteText: async () => pasteResult, isOwnProcess: pid => pid === 1 }) };
}
const front = (pid, window, app = "Microsoft Word") => JSON.stringify({ ok: true, pid, app, bundleId: "com.microsoft.Word", window, accessibility: true });

test("helper output parsing and origin validation", () => {
  assert.deepEqual(parseHelperJson("noise\n{\"ok\":true,\"pid\":5}\n"), { ok: true, pid: 5 });
  assert.equal(parseHelperJson("not json"), null);
  const origin = { pid: 5, bundleId: "com.microsoft.Word", window: "Lease.docx" };
  assert.equal(originMatches(origin, { ok: true, pid: 5, bundleId: "com.microsoft.Word", window: "Lease.docx" }), true);
  assert.equal(originMatches(origin, { ok: true, pid: 5, bundleId: "com.microsoft.Word", window: "Other.docx" }), false);
  assert.equal(originMatches(origin, { ok: true, pid: 6, bundleId: "com.microsoft.Word", window: "Lease.docx" }), false);
  assert.equal(originMatches(origin, { ok: false }), false);
});

test("the origin is captured before the panel, LegalWork itself is never an origin, and the selection reads against that origin", async () => {
  const { service: origins, calls } = service("darwin", [front(1, "LegalWork"), front(42, "Lease.docx"), JSON.stringify({ ok: true, text: "Clause 4" }), JSON.stringify({ ok: false, reason: "changed" })]);
  assert.equal(await origins.capture(), null);
  const origin = await origins.capture();
  assert.equal(origin.app, "Microsoft Word");
  assert.equal(origin.pid, 42);
  assert.deepEqual(await origins.selection("origin_unknown"), { ok: false, reason: "no-origin", message: "The source app was not recorded.", origin: null });
  const selection = await origins.selection(origin.id);
  assert.deepEqual(selection, { ok: true, text: "Clause 4", origin });
  assert.deepEqual(calls.at(-1), ["/helper", "--selected-text", "42"]);
  assert.deepEqual(await origins.selection(origin.id), { ok: false, reason: "changed", message: "", origin });
});

test("a selection shortcut prefetches the selection once for the panel", async () => {
  const { service: origins } = service("darwin", [front(42, "Lease.docx"), JSON.stringify({ ok: true, text: "Clause 9" }), JSON.stringify({ ok: false, reason: "empty" })]);
  const origin = await origins.capture();
  assert.equal((await origins.prefetchSelection()).ok, true);
  assert.deepEqual(await origins.selection(origin.id), { ok: true, text: "Clause 9", origin });
  assert.equal(/** @type {any} */ (await origins.selection(origin.id)).reason, "empty");
});

test("insertion requires the validated destination; a changed document copies instead of pasting elsewhere", async () => {
  const changed = service("darwin", [front(42, "Lease.docx"), JSON.stringify({ ok: true }), front(42, "Other.docx")]);
  const origin = await changed.service.capture();
  const result = await changed.service.insert(origin.id, "Inserted text");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "changed");
  assert.equal(result.copied, true);
  assert.equal(changed.clipboard.text, "Inserted text");
  const same = service("darwin", [front(42, "Lease.docx"), JSON.stringify({ ok: true }), front(42, "Lease.docx")]);
  const origin2 = await same.service.capture();
  assert.deepEqual(await same.service.insert(origin2.id, "Inserted text"), { ok: true, method: "paste", origin: origin2 });
  const denied = service("darwin", [front(42, "Lease.docx"), JSON.stringify({ ok: true }), front(42, "Lease.docx")], { pasted: false, copied: true, error: "Accessibility is not enabled." });
  const origin3 = await denied.service.capture();
  assert.equal(/** @type {any} */ (await denied.service.insert(origin3.id, "x")).reason, "denied");
  const linux = new OriginService({ platform: "linux", exec: async () => "", clipboard: { readText: () => "", writeText: () => {} }, pasteText: async () => ({ pasted: false, copied: true, error: null }) });
  assert.equal(await linux.capture(), null);
  assert.equal(linux.capabilities().selection, false);
});

test("on Windows a plain open never advertises the selection; the selection shortcut reads it before the panel and then offers it", async () => {
  const { service: origins } = service("windows", [front(7, "Lease.docx", "WINWORD"), JSON.stringify({ ok: true, text: "Clause 9" })]);
  const origin = await origins.capture();
  assert.equal(origin.supportsSelection, false);
  const plain = await origins.selection(origin.id);
  assert.equal(plain.ok, false);
  assert.equal(plain.ok === false && plain.reason, "changed");
  assert.deepEqual(await origins.prefetchSelection(), { ok: true, text: "Clause 9", origin });
  assert.equal(origin.supportsSelection, true);
  assert.deepEqual(await origins.selection(origin.id), { ok: true, text: "Clause 9", origin });
});

test("reopening from another application cannot retarget an earlier automatic insert", async () => {
  const { service: origins, clipboard } = service("darwin", [front(42, "A.docx"), front(43, "B.docx")]);
  const original = await origins.capture();
  await origins.capture();
  const result = await origins.insert(original.id, "Reply for A");
  assert.equal(result.ok, false);
  assert.equal(clipboard.text, "Reply for A");
  assert.equal(originMatches({ pid: 42, window: "A.docx" }, { ok: true, pid: 42, window: null }), false);
});
