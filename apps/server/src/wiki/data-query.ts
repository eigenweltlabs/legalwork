import { createHash } from "node:crypto";
import type { WikiPage, WikiValue } from "@legalwork/types/wiki";
import type { WikiDataQuery, WikiDataResult, WikiFields } from "@legalwork/types/views";
import { ApiError } from "../errors.js";

const builtins = new Set(["path", "title", "type", "updatedAt", "revision"]);
const compare = (a: WikiValue | undefined, b: WikiValue | undefined): number => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};
const equal = (a: WikiValue | undefined, b: WikiValue | undefined) => JSON.stringify(a) === JSON.stringify(b);
function property(page: WikiPage, field: string): WikiValue | undefined {
  if (field === "path") return page.path;
  if (field === "title") return page.title;
  if (field === "type") return page.type;
  if (field === "updatedAt") return page.updatedAt;
  if (field === "revision") return page.revision;
  const key = field.startsWith("properties.") ? field.slice(11) : field;
  return Object.hasOwn(page.properties, key) ? page.properties[key] : undefined;
}
function matches(actual: WikiValue | undefined, filter: NonNullable<WikiDataQuery["filters"]>[number]) {
  const expected = filter.value;
  switch (filter.op) {
    case "eq": return equal(actual, expected);
    case "ne": return !equal(actual, expected);
    case "exists": return (actual !== undefined && actual !== null) === (expected !== false);
    case "in": return Array.isArray(expected) && expected.some(value => equal(actual, value));
    case "contains": return Array.isArray(actual) ? actual.some(value => equal(value, expected))
      : typeof actual === "string" && typeof expected === "string" && actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
  }
}

/** Operates on the server's parsed index, never page bodies in the renderer. */
export function queryWikiPages(pages: WikiPage[], query: WikiDataQuery): WikiDataResult {
  const available = new Set(builtins);
  for (const page of pages) for (const name of Object.keys(page.properties)) { available.add(`properties.${name}`); available.add(name); }
  return queryIndexedRows(pages, query, available, property, ["path", "title"]);
}

export function queryIndexedRows<T extends { path: string; revision: string; updatedAt: number; type: string }>(
  pages: T[], query: WikiDataQuery, available: Set<string>,
  property: (row: T, field: string) => WikiValue | undefined,
  sourceFieldsToInclude: string[], emptySum: number | null = 0,
): WikiDataResult {
  const aggregate = !!query.groupBy || !!query.metrics?.length;
  const metrics = query.metrics?.length ? query.metrics : query.groupBy ? [{ name: "count", op: "count" } satisfies NonNullable<WikiDataQuery["metrics"]>[number]] : [];
  const metricNames = new Set(metrics.map(metric => metric.name));
  const sourceFields = [...(query.filters ?? []).map(filter => filter.field), ...(query.groupBy ? [query.groupBy] : []), ...(query.metrics ?? []).flatMap(metric => metric.field ? [metric.field] : [])];
  const outputFields = aggregate ? new Set([...metricNames, ...(query.groupBy ? [query.groupBy] : [])]) : available;
  if (sourceFields.some(field => !available.has(field)) || [...query.fields, ...(query.sort ?? []).map(sort => sort.field)].some(field => !outputFields.has(field))) throw new ApiError(400, "wiki_unknown_field", "Select available fields. For aggregates, select the grouping field and metric names.");
  if (query.metrics?.some(metric => metric.op !== "count" && !metric.field)) throw new ApiError(400, "wiki_invalid_metric", "Choose a numeric field for this aggregate.");
  if (metricNames.size !== metrics.length || (query.groupBy && metricNames.has(query.groupBy))) throw new ApiError(400, "wiki_invalid_metric", "Metric names must be unique and distinct from the grouping field.");
  if (query.filters?.some(filter => filter.op === "in" && !Array.isArray(filter.value) || filter.op !== "exists" && filter.value === undefined)) throw new ApiError(400, "wiki_invalid_filter", "Choose a value for each filter; in requires a list.");
  const { cursor, ...definition } = query;
  const digest = createHash("sha256").update(JSON.stringify(definition));
  for (const page of pages) digest.update(page.path).update("\0").update(page.revision).update("\0").update(String(page.updatedAt)).update("\0");
  const revision = digest.digest("hex");
  let offset = 0;
  if (cursor) {
    const match = /^([a-f0-9]{64}):(\d+)$/.exec(cursor);
    if (!match || match[1] !== revision) throw new ApiError(409, "wiki_query_changed", "The source data changed. Start this query again.");
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset)) throw new ApiError(400, "wiki_invalid_cursor", "Invalid query cursor.");
  }
  const matching = pages.filter(page => (!query.pageType || page.type === query.pageType) && (query.filters ?? []).every(filter => matches(property(page, filter.field), filter)));
  let rows: Record<string, WikiValue>[];
  if (query.groupBy || query.metrics?.length) {
    const groups = new Map<string, { value: WikiValue; pages: T[] }>();
    if (!query.groupBy) groups.set("all", { value: null, pages: matching });
    else for (const page of matching) {
      const value = property(page, query.groupBy) ?? null, key = JSON.stringify(value);
      const group = groups.get(key);
      if (group) group.pages.push(page); else groups.set(key, { value, pages: [page] });
    }
    rows = [...groups.values()].map(group => {
      const row: Record<string, WikiValue> = {};
      if (query.groupBy) row[query.groupBy] = group.value;
      for (const metric of metrics) {
        if (metric.op === "count") { row[metric.name] = group.pages.length; continue; }
        const numbers = group.pages.map(page => metric.field ? property(page, metric.field) : undefined).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        if (!numbers.length) { row[metric.name] = metric.op === "sum" ? emptySum : null; continue; }
        const sum = numbers.reduce((total, value) => total + value, 0);
        row[metric.name] = metric.op === "sum" ? sum : metric.op === "avg" ? sum / numbers.length
          : numbers.reduce((result, value) => metric.op === "min" ? Math.min(result, value) : Math.max(result, value));
      }
      return row;
    });
  } else {
    matching.sort((a, b) => {
      for (const sort of query.sort ?? []) { const result = compare(property(a, sort.field), property(b, sort.field)); if (result) return sort.direction === "desc" ? -result : result; }
      return a.path.localeCompare(b.path);
    });
    rows = matching.map(page => Object.fromEntries([...new Set([...sourceFieldsToInclude, ...query.fields])].map(field => [field, property(page, field) ?? null])));
  }
  if ((query.groupBy || query.metrics?.length) && query.sort?.length) rows.sort((a, b) => {
    for (const sort of query.sort ?? []) { const result = compare(a[sort.field], b[sort.field]); if (result) return sort.direction === "desc" ? -result : result; }
    return 0;
  });
  const total = rows.length, limit = query.limit ?? 100, slice = rows.slice(offset, offset + limit);
  const byPath = new Map(matching.map(page => [page.path, page]));
  const sources = !sourceFieldsToInclude.includes("path") || query.groupBy || query.metrics?.length ? undefined : slice.flatMap(row => {
    const source = typeof row.path === "string" ? byPath.get(row.path) : undefined;
    return source ? [{ path: source.path, revision: source.revision }] : [];
  });
  return { rows: slice, total, revision, asOf: Date.now(), truncated: offset + slice.length < total,
    ...(offset + slice.length < total ? { nextCursor: `${revision}:${offset + slice.length}` } : {}), ...(sources ? { sources } : {}) };
}

export function wikiPageFields(pages: WikiPage[]): WikiFields {
  const fields: WikiFields["fields"] = [...builtins].map(id => ({ id, name: id, type: id === "updatedAt" ? "number" : "string" }));
  const properties = new Map<string, { types: Set<WikiFields["fields"][number]["type"]>; values: Map<string, WikiValue> }>();
  for (const page of pages) for (const [name, value] of Object.entries(page.properties)) {
    if (["__proto__", "constructor", "prototype"].includes(name)) continue;
    let entry = properties.get(name);
    if (!entry) { entry = { types: new Set(), values: new Map() }; properties.set(name, entry); }
    if (value === null) continue;
    const type = Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean"
      : /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) ? "date" : "string";
    entry.types.add(type);
    if (type !== "object" && type !== "array" && entry.values.size < 50) entry.values.set(JSON.stringify(value), value);
  }
  for (const [name, entry] of properties) fields.push({ id: `properties.${name}`, name, type: entry.types.size === 1 ? [...entry.types][0] : "mixed", values: [...entry.values.values()] });
  return { fields };
}
