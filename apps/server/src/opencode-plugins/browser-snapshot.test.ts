import { expect, test } from "bun:test";
import { ZodError } from "zod";
import { browserConnectionResult, compactBrowserResult } from "./browser-snapshot.js";

test("browser failures preserve their runtime message/code instead of becoming argument-validation errors", () => {
  const message = "The local browser engine is unavailable.";
  expect(() => browserConnectionResult({ ok: false, error: message, code: "engine_unavailable" })).toThrow(message);
  try { browserConnectionResult({ ok: false, error: message, code: "engine_unavailable" }); }
  catch (error) { expect(error).toMatchObject({ message, code: "engine_unavailable" }); expect(error).not.toBeInstanceOf(ZodError); }
  expect(() => browserConnectionResult({ ok: true, result: { tab_id: "tab" } })).toThrow("The browser returned an invalid connection response.");
});

test("large snapshots remain valid JSON and paginate all text and selectors without truncation", () => {
  const long = "A quoted \"clause\" with tabs\t and Unicode € 中文.\n".repeat(3_000);
  const input = { ok: true, result: { tabId: "task-tab", snapshot: {
    elements: [{ role: "StaticText", name: long }, { role: "InlineTextBox", name: long }, { role: "StaticText", name: "Last paragraph" }],
    controls: Array.from({ length: 300 }, (_, i) => ({ role: "link", name: `Source ${i}`, selector: `[id=source-${i}]` })),
  } } };
  let snapshotOffset = 0, controlsOffset = 0, text = "";
  const selectors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const serialized = JSON.stringify(compactBrowserResult(input, snapshotOffset, controlsOffset));
    expect(Buffer.byteLength(serialized)).toBeLessThan(30_000);
    expect(serialized.split("\n")).toHaveLength(1);
    const snapshot = JSON.parse(serialized).result.snapshot;
    text += snapshot.elements.map((element: { name: string }) => element.name).join("");
    snapshot.controls.forEach((control: { selector: string }) => selectors.add(control.selector));
    const { pagination } = snapshot;
    if (pagination.snapshotOffset === undefined && pagination.controlsOffset === undefined) break;
    snapshotOffset = pagination.snapshotOffset ?? pagination.totalElements;
    controlsOffset = pagination.controlsOffset ?? pagination.totalControls;
  }
  expect(text).toBe(long + "Last paragraph");
  expect(selectors.size).toBe(300);
});
