import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import { Dropdown } from "twenty-ui/components/navigation";
import { DirectoryMenu } from "./twenty-controls";
import { revealGridColumn } from "./record-grid-columns";
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
  worked: 78,
  billableWork: 150,
  nonBillable: 172,
  charge: 92,
};

export function useTimesheetColumns(scope: string, grid: RefObject<HTMLDivElement | null>) {
  const key = "legalwork.timesheet.columns." + scope;
  const [hidden, setHidden] = useState<RowColumn[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      if (Array.isArray(saved)) return optional.filter((field) => saved.includes(field));
    } catch {
      /* Use the default view if storage is unavailable. */
    }
    return ["billableWork", "nonBillable"];
  });
  const newField = useRef<RowColumn | null>(null);
  useLayoutEffect(() => {
    if (newField.current) revealGridColumn(grid.current, newField.current);
    newField.current = null;
  }, [hidden, grid]);
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
      <DirectoryMenu trigger={<Button variant="ghost" size="sm">{t("back_office.options")}</Button>}>
        <Dropdown.Header><Dropdown.Title>{t("back_office.visible_fields")}</Dropdown.Title></Dropdown.Header>
        {optional.map(field => (
          <Dropdown.OptionItem key={field} value={field} indicator="checkbox" selected={!hidden.includes(field)} closeOnSelect={false}
            disabled={durations.includes(field) && columns.filter(column => durations.includes(column)).length === 1 && !hidden.includes(field)}
            onSelect={() => {
              if (hidden.includes(field)) {
                newField.current = field;
                change(hidden.filter(column => column !== field));
              } else change([...hidden, field]);
            }}>
            {t(ledgerColumnKeys[field])}
          </Dropdown.OptionItem>
        ))}
        <Dropdown.Separator />
        <Dropdown.ActionItem startIcon={<RotateCcw size={13} />} onClick={() => change(["billableWork", "nonBillable"])}>
          {t("timesheets.reset_columns")}
        </Dropdown.ActionItem>
      </DirectoryMenu>
    ),
  };
}
