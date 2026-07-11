import { describe, expect, test } from "bun:test";
import type { BenchmarkCatalogItem, BenchmarkTaskItem } from "../src/app/lib/benchmark-types";
import {
  EMPTY_TABLE_FILTERS,
  EMPTY_TASK_FILTERS,
  collectTaskTags,
  filterCatalogTasks,
  filterTaskRows,
} from "../src/react-app/domains/benchmark/filter-tasks";

function taskRow(patch: Partial<BenchmarkTaskItem>): BenchmarkTaskItem {
  return {
    id: "t",
    source: "harvey",
    title: "Task",
    workType: "draft",
    tags: [],
    instructions: "",
    deliverables: [],
    criteria: [],
    criteriaCount: 0,
    docCount: 0,
    catalogRef: null,
    createdAt: 1,
    updatedAt: 1,
    latestResults: [],
    ...patch,
  };
}

describe("filterTaskRows", () => {
  const ROWS = [
    taskRow({ id: "a", title: "Draft Tax Memo", workType: "draft", tags: ["Tax", "memo"] }),
    taskRow({ id: "b", title: "Analyze NDA", workType: "analyze", tags: ["Contracts"] }),
    taskRow({ id: "c", title: "Custom review", workType: "review", tags: ["Contracts", "NDA"], instructions: "check indemnity" }),
  ];

  test("empty filters return everything", () => {
    expect(filterTaskRows(ROWS, EMPTY_TABLE_FILTERS)).toHaveLength(3);
  });

  test("work-type and tag facets are AND across, OR within", () => {
    expect(filterTaskRows(ROWS, { ...EMPTY_TABLE_FILTERS, tags: ["Contracts"] })).toHaveLength(2);
    expect(filterTaskRows(ROWS, { ...EMPTY_TABLE_FILTERS, tags: ["Tax", "NDA"] })).toHaveLength(2);
    expect(
      filterTaskRows(ROWS, { ...EMPTY_TABLE_FILTERS, tags: ["Contracts"], workTypes: ["review"] }),
    ).toEqual([ROWS[2]]);
  });

  test("search covers title, tags and instructions", () => {
    expect(filterTaskRows(ROWS, { ...EMPTY_TABLE_FILTERS, search: "indemnity" })).toEqual([ROWS[2]]);
    expect(filterTaskRows(ROWS, { ...EMPTY_TABLE_FILTERS, search: "MEMO" })).toEqual([ROWS[0]]);
    expect(filterTaskRows(ROWS, { ...EMPTY_TABLE_FILTERS, search: "zzz" })).toHaveLength(0);
  });

  test("collectTaskTags dedupes and orders by frequency", () => {
    expect(collectTaskTags(ROWS)).toEqual(["Contracts", "memo", "NDA", "Tax"]);
  });
});

const ITEMS: BenchmarkCatalogItem[] = [
  {
    key: "tasks/tax/draft-tax-memo",
    source: "harvey",
    vertical: "tax",
    verticalLabel: "Tax",
    name: "draft-tax-memo",
    docCount: 2,
    hydrated: true,
    title: "Draft Tax Memo",
    workType: "draft",
    tags: ["Tax", "memo drafting"],
  },
  {
    key: "tasks/contracts/analyze-nda",
    source: "harvey",
    vertical: "contracts",
    verticalLabel: "Contracts",
    name: "analyze-nda",
    docCount: 1,
    hydrated: true,
    title: "Analyze NDA",
    workType: "analyze",
  },
  {
    key: "tasks/contracts/unhydrated-task",
    source: "harvey",
    vertical: "contracts",
    verticalLabel: "Contracts",
    name: "unhydrated-task",
    docCount: 0,
    hydrated: false,
  },
  {
    key: "ct_1",
    source: "custom",
    vertical: "Contracts",
    verticalLabel: "Contracts",
    name: "ct_1",
    docCount: 0,
    hydrated: true,
    title: "Review supplier agreement",
    workType: "review",
    instructions: "Check the indemnity clause carefully.",
  },
];

describe("filterCatalogTasks", () => {
  test("empty filters return everything", () => {
    expect(filterCatalogTasks(ITEMS, EMPTY_TASK_FILTERS)).toHaveLength(4);
  });

  test("tag facet is OR within, AND across facets; practice area doubles as a tag", () => {
    expect(filterCatalogTasks(ITEMS, { ...EMPTY_TASK_FILTERS, tags: ["memo drafting"] })).toHaveLength(1);
    // Unhydrated/tagless items match through their practice-area label.
    expect(filterCatalogTasks(ITEMS, { ...EMPTY_TASK_FILTERS, tags: ["Contracts"] })).toHaveLength(3);
    expect(filterCatalogTasks(ITEMS, { ...EMPTY_TASK_FILTERS, tags: ["Tax", "Contracts"] })).toHaveLength(4);
    expect(
      filterCatalogTasks(ITEMS, { ...EMPTY_TASK_FILTERS, tags: ["Contracts"], workTypes: ["analyze"] }),
    ).toHaveLength(1);
  });

  test("work-type facet excludes unhydrated items while active", () => {
    const filtered = filterCatalogTasks(ITEMS, { ...EMPTY_TASK_FILTERS, workTypes: ["draft", "analyze", "review"] });
    expect(filtered.map((item) => item.key)).not.toContain("tasks/contracts/unhydrated-task");
    expect(filtered).toHaveLength(3);
  });

  test("search is case-insensitive across title, name, vertical and instructions", () => {
    expect(filterCatalogTasks(ITEMS, { ...EMPTY_TASK_FILTERS, search: "TAX MEMO" })).toHaveLength(1);
    expect(filterCatalogTasks(ITEMS, { ...EMPTY_TASK_FILTERS, search: "unhydrated" })).toHaveLength(1);
    expect(filterCatalogTasks(ITEMS, { ...EMPTY_TASK_FILTERS, search: "indemnity" })).toHaveLength(1);
    expect(filterCatalogTasks(ITEMS, { ...EMPTY_TASK_FILTERS, search: "zzz-nope" })).toHaveLength(0);
  });
});
