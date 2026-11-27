import { useEffect, useState } from "react";
import { z, type BackOfficeView } from "@legalwork/types/back-office";

const layoutSchema = z.object({
  columns: z.array(z.string()).min(1).max(100),
  widths: z.record(z.string(), z.number().min(80).max(800)),
});
type ColumnLayout = z.infer<typeof layoutSchema>;
const rowHeightSchema = z.enum(["compact", "tall", "auto"]);
export type RecordRowHeight = z.infer<typeof rowHeightSchema>;

// Named views belong to the directory. A personal layout applies until someone
// changes the shared columns or widths, at which point the shared layout wins.
export function useRecordGridColumns(scope: string, objectId: string, defaults: ColumnLayout, initialView?: BackOfficeView) {
  const load = (view?: BackOfficeView) => {
    const shared = view ? { columns: view.columns, widths: view.widths } : defaults;
    const base = view ? JSON.stringify([view.columns, Object.entries(view.widths).sort(([a], [b]) => a.localeCompare(b))]) : "default";
    const key = "legalwork.record-grid.columns." + JSON.stringify([scope, objectId, view?.id ?? null]);
    try {
      const saved = layoutSchema.extend({ base: z.string(), rowHeight: rowHeightSchema.catch("compact") }).safeParse(JSON.parse(localStorage.getItem(key) ?? "null"));
      if (saved.success) return {
        ...(saved.data.base === base ? saved.data : shared),
        rowHeight: saved.data.rowHeight, key, base, changed: false,
      };
    } catch { /* Storage may be unavailable. */ }
    const rowHeight: RecordRowHeight = "compact";
    return { ...shared, key, base, rowHeight, changed: false };
  };
  const [layout, setLayout] = useState(() => load(initialView));
  useEffect(() => {
    if (!layout.changed) return;
    try {
      const { columns, widths, base, rowHeight } = layout;
      localStorage.setItem(layout.key, JSON.stringify({ columns, widths, base, rowHeight }));
    } catch { /* Keep the current session usable without storage. */ }
  }, [layout]);
  return {
    acknowledgeLayout: (view: BackOfficeView) => {
      const saved = load(view);
      setLayout(current => current.key === saved.key ? { ...current, base: saved.base } : current);
    },
    columns: layout.columns,
    widths: layout.widths,
    rowHeight: layout.rowHeight,
    setColumns: (update: (columns: string[]) => string[]) =>
      setLayout(current => ({ ...current, changed: true, columns: update(current.columns) })),
    setWidths: (update: (widths: Record<string, number>) => Record<string, number>) =>
      setLayout(current => ({ ...current, changed: true, widths: update(current.widths) })),
    setRowHeight: (rowHeight: RecordRowHeight) =>
      setLayout(current => ({ ...current, changed: true, rowHeight })),
    selectLayout: (view?: BackOfficeView) => setLayout(load(view)),
  };
}

// Move only the grid horizontally. The open menu, workspace and page keep focus
// and position while the newly displayed field comes into view.
export function revealGridColumn(grid: HTMLElement | null, field: string) {
  const heading = grid && Array.from(grid.querySelectorAll<HTMLElement>('[role="columnheader"][data-field]')).find(item => item.dataset.field === field);
  if (!grid || !heading) return;
  const column = heading.getBoundingClientRect(), viewport = grid.getBoundingClientRect();
  if (column.right > viewport.right) grid.scrollLeft += Math.min(column.left - viewport.left, column.right - viewport.right);
  else if (column.left < viewport.left) grid.scrollLeft += column.left - viewport.left;
}
