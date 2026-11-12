import { describe, expect, test } from "bun:test";
import type { WikiPage } from "@legalwork/types/wiki";
import { ViewInputSchema } from "@legalwork/types/views";
import { queryWikiPages, wikiPageFields } from "./data-query.js";

const pages: WikiPage[] = Array.from({ length: 205 }, (_, index) => ({ path: `Clients/${index}.md`, title: `Client ${index}`, type: "client", properties: {
  stage: index % 2 ? "active" : "lead", amount: index, optedIn: index % 2 === 0, due: "2026-10-20", optional: null,
}, links: [], excerpt: "", revision: `revision-${index}`, updatedAt: index }));

describe("typed wiki data queries", () => {
  test("aggregates all matching records before pagination", () => {
    const result = queryWikiPages(pages, { fields: ["stage"], groupBy: "stage", limit: 1, metrics: [{ name: "count", op: "count" }, { name: "value", op: "sum", field: "amount" }] });
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.rows[0]).toEqual({ stage: "lead", count: 103, value: 10506 });
  });
  test("preserves false and zero and sorts by an unselected field", () => {
    const result = queryWikiPages(pages, { fields: ["optedIn"], sort: [{ field: "amount", direction: "desc" }], limit: 1 });
    expect(result.rows[0]).toEqual({ path: "Clients/204.md", title: "Client 204", optedIn: true });
    const zero = queryWikiPages(pages, { fields: ["amount"], filters: [{ field: "amount", op: "eq", value: 0 }] });
    expect(zero.rows[0].amount).toBe(0);
    const falseValue = queryWikiPages(pages, { fields: ["optedIn"], filters: [{ field: "optedIn", op: "eq", value: false }] });
    expect(falseValue.total).toBe(102);
  });
  test("cursor is scoped to query and source revision", () => {
    const query = { fields: ["title"], limit: 2 };
    const first = queryWikiPages(pages, query);
    const second = queryWikiPages(pages, { ...query, cursor: first.nextCursor });
    expect(second.rows[0].path).not.toBe(first.rows[0].path);
    expect(() => queryWikiPages(pages, { ...query, fields: ["path"], cursor: first.nextCursor })).toThrow("source data changed");
    expect(() => queryWikiPages(pages.slice(1), { ...query, cursor: first.nextCursor })).toThrow("source data changed");
  });
  test("rejects invented fields and malformed metrics", () => {
    expect(() => queryWikiPages(pages, { fields: ["secrets"] })).toThrow(expect.objectContaining({ status: 400, code: "wiki_unknown_field" }));
    expect(() => queryWikiPages(pages, { fields: ["average"], metrics: [{ name: "average", op: "avg" }] })).toThrow("numeric field");
    expect(() => queryWikiPages(pages, { fields: ["amount"], filters: [{ field: "stage", op: "in", value: "active" }] })).toThrow("requires a list");
  });
  test("field schema distinguishes property names from built-ins", () => {
    const fields = wikiPageFields(pages).fields;
    expect(fields.find(field => field.id === "properties.optedIn")?.type).toBe("boolean");
    expect(fields.find(field => field.id === "properties.due")?.type).toBe("date");
    expect(fields.find(field => field.id === "updatedAt")?.type).toBe("number");
  });
  test("empty aggregate count is zero rather than missing", () => {
    expect(queryWikiPages([], { fields: ["total"], metrics: [{ name: "total", op: "count" }] }).rows).toEqual([{ total: 0 }]);
  });
  test("group output accepts default count and rejects sorting on unaggregated fields", () => {
    expect(queryWikiPages(pages, { fields: ["stage", "count"], groupBy: "stage" }).rows[0]).toEqual({ stage: "lead", count: 103 });
    expect(() => queryWikiPages(pages, { fields: ["stage"], groupBy: "stage", sort: [{ field: "amount", direction: "asc" }] })).toThrow("grouping field");
  });
  test("touching an unchanged page invalidates time-sensitive pagination", () => {
    const query = { fields: ["title"], limit: 1 };
    const first = queryWikiPages(pages, query);
    expect(() => queryWikiPages(pages.map((page, i) => i ? page : { ...page, updatedAt: 999 }), { ...query, cursor: first.nextCursor })).toThrow("source data changed");
  });
  test("saved view definitions cannot retain a stale pagination cursor", () => {
    expect(ViewInputSchema.safeParse({ version: 1, title: "Dashboard", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Example")', queries: { pages: { fields: ["title"], cursor: "old:0" } } }).success).toBe(false);
  });
});
