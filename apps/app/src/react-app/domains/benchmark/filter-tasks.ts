import type { BenchmarkCatalogItem, BenchmarkTaskItem, BenchmarkWorkType } from "../../../app/lib/benchmark-types";

export type BenchmarkTaskFilters = {
  workTypes: BenchmarkWorkType[];
  tags: string[];
  search: string;
};

export const EMPTY_TASK_FILTERS: BenchmarkTaskFilters = {
  workTypes: [],
  tags: [],
  search: "",
};

export type TaskTableFilters = BenchmarkTaskFilters;

export const EMPTY_TABLE_FILTERS: TaskTableFilters = EMPTY_TASK_FILTERS;

/** Task-table filtering: AND across facets, OR within a facet (practice areas are just tags). */
export function filterTaskRows(tasks: BenchmarkTaskItem[], filters: TaskTableFilters): BenchmarkTaskItem[] {
  const search = filters.search.trim().toLowerCase();
  return tasks.filter((task) => {
    if (filters.workTypes.length && !filters.workTypes.includes(task.workType)) return false;
    if (filters.tags.length && !task.tags.some((tag) => filters.tags.includes(tag))) return false;
    if (search) {
      const haystack = `${task.title} ${task.tags.join(" ")} ${task.instructions}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/** Union of all tags across tasks, most frequent first — feeds the tag filter and autocomplete. */
export function collectTaskTags(tasks: BenchmarkTaskItem[]): string[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    for (const tag of task.tags) {
      const trimmed = tag.trim();
      if (!trimmed) continue;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

/** A catalog item's tags; the practice-area label doubles as a tag until hydration fills in the rest. */
export function catalogItemTags(item: BenchmarkCatalogItem): string[] {
  return item.tags?.length ? item.tags : [item.verticalLabel];
}

/**
 * AND across facets, OR within a facet. Work-type and full tag lists only
 * exist on hydrated items (practice area is known for all), so unhydrated
 * entries match the tag facet through their practice-area label only.
 */
export function filterCatalogTasks(
  items: BenchmarkCatalogItem[],
  filters: BenchmarkTaskFilters,
): BenchmarkCatalogItem[] {
  const search = filters.search.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.tags.length && !catalogItemTags(item).some((tag) => filters.tags.includes(tag))) return false;
    if (filters.workTypes.length && (!item.workType || !filters.workTypes.includes(item.workType))) {
      return false;
    }
    if (search) {
      const haystack = `${item.title ?? ""} ${item.name} ${item.verticalLabel} ${item.instructions ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

/** Union of tags across catalog items, most frequent first — feeds the importer's tag filter. */
export function collectCatalogTags(items: BenchmarkCatalogItem[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of catalogItemTags(item)) {
      const trimmed = tag.trim();
      if (!trimmed) continue;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}
