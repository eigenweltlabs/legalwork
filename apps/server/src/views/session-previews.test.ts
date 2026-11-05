import { describe, test, expect } from "bun:test";
import type { ViewPreview, ViewRecord, ViewOwner } from "@legalwork/types/views";
import { reviewSessionViews, sessionViewPreviews, savedViewMatchesPreview } from "./session-previews.js";
const preview: ViewPreview = { status: "preview", owner: { kind: "workspace", id: "project" }, input: { version: 1, title: "Report", mode: "report", catalog: "legalwork-1", program: 'root = Text("hello")', queries: {}, datasets: { rows: { rows: [{ count: 1 }], total: 1, revision: "r1", asOf: 12, truncated: false } } } };
const saved: ViewRecord = { ...preview.input, owner: preview.owner, id: "0615856d-1420-4879-b647-96543f4ef861", revision: "saved", updatedAt: 100 };
const part = (state: unknown, callID = "call1") => ({ type: "tool", name: "view_create", id: callID, state });

describe("session dashboard deletion review", () => {
  test("reads full metadata and native text including migrated output, ignores failed and incomplete tools", () => {
    const items = sessionViewPreviews([{ type: "assistant", content: [part({ status: "completed", content: [{type:"text",text:"truncated"}], metadata: { legalworkViewPreview: preview } }), part({ status: "completed", content: [{type:"text",text:JSON.stringify(preview)}] }, "call2"), part({ status: "error", content: [{type:"text",text:JSON.stringify(preview)}] }), part({ status: "running", content: [] })] }]);
    expect(items.map(item => item.callId)).toEqual(["call1", "call2"]);
    expect(items[0].preview?.input.program).toBe(preview.input.program);
  });
  test("warns about truncated old previews but not failed generation results", () => {
    expect(sessionViewPreviews([{ type: "assistant", content: [part({ status: "completed", content: [{type:"text",text:"partial"}], metadata: { truncated: true } })] }])).toEqual([{ callId: "call1", title: "Dashboard preview (content unavailable)" }]);
    expect(sessionViewPreviews([{ type: "assistant", content: [part({ status: "completed", content: [{type:"text",text:'{"ok":false,"error":"invalid"}'}] })] }])).toEqual([]);
  });
  test("recognizes existing copies without browser state, but warns when a copy was deleted", () => {
    const items = [{ callId: "call1", title: preview.input.title, preview }];
    expect(reviewSessionViews(items, [saved], "project", "chat").items).toEqual([]);
    expect(reviewSessionViews(items, [], "project", "chat").items).toHaveLength(1);
    expect(savedViewMatchesPreview({ ...saved, program: 'root = Text("other")' }, preview)).toBe(false);
    expect(savedViewMatchesPreview({ ...saved, datasets: {} }, preview)).toBe(false);
  });
  test("new previews invalidate an earlier discard confirmation", () => {
    const items = [{ callId: "call1", title: preview.input.title, preview }];
    const before = reviewSessionViews(items, [], "project", "chat");
    const after = reviewSessionViews([...items, { ...items[0], callId: "call2" }], [], "project", "chat");
    expect(after.reviewToken).not.toBe(before.reviewToken);
  });
  test("frozen copies in another wiki retain the original source", () => {
    const copy = { ...saved, owner: { kind: "wiki", id: "wiki" } satisfies ViewOwner, datasets: { rows: { ...preview.input.datasets!.rows, sourceOwner: preview.owner } } };
    expect(savedViewMatchesPreview(copy, preview)).toBe(true);
    expect(savedViewMatchesPreview({ ...copy, datasets: {} }, preview)).toBe(false);
  });
});

test("a saved report with the same live query but older rows does not protect a newer unsaved report", () => {
  const report: ViewPreview = { ...preview, owner: { kind: "wiki", id: "wiki" }, input: { ...preview.input, queries: { rows: { fields: ["count"] } } } };
  const older: ViewRecord = { ...saved, owner: report.owner, queries: report.input.queries, datasets: { rows: { ...preview.input.datasets!.rows, rows: [{ count: 0 }] } } };
  expect(savedViewMatchesPreview(older, report)).toBe(false);
});

test("mixed live dashboards still protect unsaved static data", () => {
  const mixed: ViewPreview = { ...preview, owner: { kind: "wiki", id: "wiki" }, input: { ...preview.input, mode: "dashboard", queries: { live: { fields: ["count"] } }, datasets: { ...preview.input.datasets, live: { rows: [{ count: 10 }], total: 1, revision: "live", asOf: 20, truncated: false } } } };
  const copy: ViewRecord = { ...saved, ...mixed.input, owner: mixed.owner, datasets: { ...mixed.input.datasets, live: { ...mixed.input.datasets!.live, rows: [] } } };
  expect(savedViewMatchesPreview(copy, mixed)).toBe(true);
  const stale = { ...copy, datasets: { ...copy.datasets, rows: { ...preview.input.datasets!.rows, rows: [{ count: 0 }] } } };
  expect(savedViewMatchesPreview(stale, mixed)).toBe(false);
  expect(reviewSessionViews([{ callId: "mixed", title: "Mixed", preview: mixed }], [stale], "project", "chat").items).toHaveLength(1);
  expect(savedViewMatchesPreview({ ...copy, datasets: { ...copy.datasets, extra: preview.input.datasets!.rows } }, mixed)).toBe(false);
});
