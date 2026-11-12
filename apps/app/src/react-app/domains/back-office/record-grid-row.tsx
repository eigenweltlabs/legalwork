import { t } from "@/i18n";
import { memo, useId, useRef, type KeyboardEvent } from "react";
import type { BackOfficeField, BackOfficeRecord, BackOfficeValue } from "@legalwork/types/back-office";
import { Checkbox } from "twenty-ui/primitives/input";
import { Popover } from "twenty-ui/primitives/surfaces";
import { CellEditor } from "./cell-editor";
import { InlineCellEditor } from "./inline-cell-editor";
import { RecordChip, ValueDisplay } from "./record-values";
import { DirectoryEditorPopup } from "./twenty-controls";

export type EditingCell = { record: string; field: string; base: BackOfficeRecord };

type RowProps = {
  record: BackOfficeRecord;
  index: number;
  top?: number;
  measure?: (element: HTMLDivElement | null) => void;
  template: string;
  fields: BackOfficeField[];
  records: BackOfficeRecord[];
  recordById?: ReadonlyMap<string, BackOfficeRecord>;
  editable: boolean;
  readOnlyFields?: readonly string[];
  localOnly?: boolean;
  userId: string;
  selected: boolean;
  editing?: EditingCell;
  onEdit: (cell: EditingCell | null) => void;
  onError: (message: string) => void;
  onSelect: (id: string, checked: boolean) => void;
  onMove: (event: KeyboardEvent<HTMLDivElement>, row: number, column: number) => void;
  onOpen: (record: BackOfficeRecord) => void;
  onSave: (record: BackOfficeRecord, values: Record<string, BackOfficeValue>) => Promise<void>;
};

export const RecordGridRow = memo(function RecordGridRow({
  record, index, top, measure, template, fields, records, recordById, editable, localOnly, userId,
  selected, editing, readOnlyFields, onEdit, onError, onSelect, onMove, onOpen, onSave,
}: RowProps) {
  const popupId = useId();
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div
      role="row"
      data-index={index}
      ref={measure}
      aria-rowindex={index + 2}
      className={`bo-grid-row ${selected ? "bo-row-selected" : ""}`}
      style={{ gridTemplateColumns: template, transform: top === undefined ? undefined : `translateY(${top}px)` }}
    >
      <div className="bo-check-cell">
        <Checkbox size="sm" disabled={record.revision === 0} aria-label={`Select ${record.values.name}`} checked={selected}
          onCheckedChange={checked => onSelect(record.id, checked)} />
      </div>
      {fields.map((field, column) => {
        const canEdit = editable && !readOnlyFields?.includes(field.id) && !(localOnly && field.type === "file") && (field.visibility !== "private" || record.ownerId === userId);
        const inline = field.id !== "name" && ["text", "email", "number", "currency"].includes(field.type);
        const active = canEdit && editing?.field === field.id;
        const edit = (cell: HTMLDivElement) => {
          if (!canEdit || active) return;
          anchor.current = cell;
          onEdit({ record: record.id, field: field.id, base: record });
        };
        return (
          <div key={field.id} role="gridcell" tabIndex={0}
            className={`bo-grid-cell ${localOnly && field.id === "name" ? "bo-local-name" : ""} ${inline && active ? "bo-inline-cell" : ""}`}
            data-row={index} data-col={column}
            aria-haspopup={canEdit && !inline ? "dialog" : undefined}
            aria-controls={active && !inline ? popupId : undefined}
            aria-expanded={canEdit && !inline ? active : undefined}
            onClick={event => edit(event.currentTarget)}
            onKeyDown={event => {
              if (event.target === event.currentTarget && (event.key === "Enter" || (!inline && event.key === " "))) {
                if (canEdit) { event.preventDefault(); edit(event.currentTarget); }
              } else if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
                onMove(event, index, column);
              }
            }}
          >
            {inline && active && editing ? (
              <InlineCellEditor field={field} value={editing.base.values[field.id]}
                onSave={value => onSave(editing.base, { [field.id]: value })}
                onCancel={() => onEdit(null)} onError={onError} />
            ) : field.id === "name" ? (
              <><RecordChip record={record} onOpen={onOpen} />{localOnly && <small className="bo-local-label">{t("back_office.local_copy")}</small>}</>
            ) : (
              <ValueDisplay field={field} value={record.values[field.id]}
                records={records} recordById={recordById} onOpen={onOpen} />
            )}
            {active && !inline && editing && (
              <Popover.Root open onOpenChange={open => { if (!open) onEdit(null); }}>
                <Popover.Portal>
                  <Popover.Positioner anchor={anchor} align="start" side="bottom" sideOffset={-32}>
                    <DirectoryEditorPopup id={popupId} finalFocus={anchor}
                      style={{ width: field.type === "date" ? "max-content" : field.type === "select" ? 200 : 260 }}>
                      <CellEditor record={editing.base} field={field}
                        value={field.multiple || field.type === "multiselect" ? record.values[field.id] : editing.base.values[field.id]} records={records}
                        onCancel={() => onEdit(null)} onSave={(value, previous) => onSave(previous ? { ...record, values: { ...record.values, [field.id]: previous } } : editing.base, { [field.id]: value })} />
                    </DirectoryEditorPopup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}
          </div>
        );
      })}
      <div className="bo-grid-fill" />
    </div>
  );
});
