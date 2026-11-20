import { useState } from "react";
import { Columns3, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { t } from "@/i18n";
import { ledgerColumnKeys } from "./timesheet-labels";
import { rowColumns, type RowColumn } from "./timesheet-row";

const optional = ["date", "workers", "product", "worked", "billableWork", "nonBillable"] as const;
const widths: Record<RowColumn, number> = {
  date: 94,
  matter: 142,
  workers: 85,
  activity: 67,
  narrative: 154,
  product: 110,
  worked: 63,
  billableWork: 88,
  nonBillable: 86,
  charge: 92,
};

export function useTimesheetColumns(scope: string) {
  const key = "legalwork.timesheet.columns." + scope;
  const [hidden, setHidden] = useState<RowColumn[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      if (Array.isArray(saved)) return optional.filter((field) => saved.includes(field));
    } catch {
      /* Use the default view if storage is unavailable. */
    }
    return ["worked"];
  });
  function change(next: RowColumn[]) {
    setHidden(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Remain usable for this session. */
    }
  }
  const columns = rowColumns.filter((field) => !hidden.includes(field));
  const durations: RowColumn[] = ["worked", "billableWork", "nonBillable"];
  const tracks = columns.map((field) =>
    field === "matter" || field === "narrative"
      ? `minmax(${widths[field]}px,${field === "matter" ? 1.15 : 1.8}fr)`
      : `${widths[field]}px`,
  );
  const layout = {
    "--time-tracks": ["56px", ...tracks, "102px"].join(" "),
    "--time-min-width": 158 + columns.reduce((n, field) => n + widths[field], 0) + "px",
  };
  return {
    columns,
    layout,
    reveal: (column: RowColumn) => {
      if (hidden.includes(column)) change(hidden.filter((f) => f !== column));
    },
    control: (
      <Popover>
        <PopoverTrigger render={<Button variant="outline" size="sm" aria-label={t("timesheets.columns")} />}>
          <Columns3 size={14} />
          {t("timesheets.columns")}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 gap-0.5 p-2">
          {optional.map((field) => (
            <label key={field} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm">
              <Checkbox
                disabled={
                  durations.includes(field) &&
                  columns.filter((c) => durations.includes(c)).length === 1 &&
                  !hidden.includes(field)
                }
                checked={!hidden.includes(field)}
                onCheckedChange={(visible) =>
                  change(visible ? hidden.filter((f) => f !== field) : [...hidden, field])
                }
              />
              {t(ledgerColumnKeys[field])}
            </label>
          ))}
          <Button variant="ghost" size="sm" onClick={() => change(["worked"])}>
            <RotateCcw size={13} />
            {t("timesheets.reset_columns")}
          </Button>
        </PopoverContent>
      </Popover>
    ),
  };
}
