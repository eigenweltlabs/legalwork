import { isTimeDurationField } from "./time-duration";
import { t } from "@/i18n";
import { memo, useId, useRef, type ReactNode, type KeyboardEvent } from "react";
import type { BackOfficeField, BackOfficeRecord, BackOfficeValue } from "@legalwork/types/back-office";
import { Checkbox } from "twenty-ui/primitives/input";
import { Popover } from "twenty-ui/primitives/surfaces";
import { CellEditor } from "./cell-editor";
import { InlineCellEditor } from "./inline-cell-editor";
import { RecordChip, ValueDisplay } from "./record-values";
import { DirectoryEditorPopup } from "./twenty-controls";

export type EditingCell = { record: string; field: string; base: BackOfficeRecord };

type RowProps = {
  sheet?: boolean;
  blank?: boolean;
  leading?: ReactNode;
  details?: ReactNode;
  trailing?: ReactNode;
  onFocus?: () => void;
  fieldValue?: (record: BackOfficeRecord, fieldId: string) => BackOfficeValue | undefined;
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
  allowedRelationIds?: (record: BackOfficeRecord, field: string) => readonly string[] | undefined;
  canTab?: (column: number, backward: boolean) => boolean;
  localOnly?: boolean;
  userId: string;
  selected: boolean;
  editing?: EditingCell;
  onEdit: (cell: EditingCell | null, expected?: EditingCell) => boolean | void;
  onError: (message: string) => void;
  onSelect: (id: string, checked: boolean) => void;
  onMove: (event: KeyboardEvent<HTMLElement>, row: number, column: number) => void;
  onOpen: (record: BackOfficeRecord) => void;
  openOnRowClick?: boolean;
  onSave: (record: BackOfficeRecord, values: Record<string, BackOfficeValue>) => Promise<void>;
};

export const RecordGridRow = memo(function RecordGridRow({
  sheet, blank, leading, details, trailing, onFocus, fieldValue, record, index, top, measure, template, fields, records, recordById, editable, localOnly, userId,
  selected, editing, readOnlyFields, allowedRelationIds, canTab, onEdit, onError, onSelect, onMove, onOpen, openOnRowClick, onSave,
}: RowProps) {
  const popupId = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const valueFor = (row: BackOfficeRecord, id: string) => fieldValue ? fieldValue(row, id) : row.values[id];
  return (
    <div
      onFocus={onFocus}
      onClick={openOnRowClick ? event => {
        if (event.defaultPrevented || !(event.target instanceof Element) ||
          event.target.closest('a, button, input, select, textarea, [role="button"], [role="checkbox"]')) return;
        onOpen(record);
      } : undefined}
      role="row"
      data-record-id={record.id}
      data-sheet-blank={blank || undefined}
      data-index={index}
      ref={measure}
      aria-rowindex={index + 2}
      className={`bo-grid-row ${details ? "bo-grid-row-detail" : ""} ${selected ? "bo-row-selected" : ""} ${openOnRowClick ? "cursor-pointer" : ""}`}
      style={{ gridTemplateColumns: template, transform: top === undefined ? undefined : `translateY(${top}px)` }}
    >
      <div className="bo-check-cell">
        {leading ?? <Checkbox size="sm" disabled={record.revision === 0} aria-label={t("back_office.select_record", { name: String(record.values.name) })} checked={selected}
          onCheckedChange={checked => onSelect(record.id, checked)} />}
      </div>
      {fields.map((field, column) => {
        const canEdit = editable && !readOnlyFields?.includes(field.id) && !(localOnly && field.type === "file") && (field.visibility !== "private" || record.ownerId === userId);
        const inline = (sheet || field.id !== "name") && (["text", "email", "number", "currency"].includes(field.type) || (sheet && (field.type === "datetime" || field.type === "date")));
        const active = canEdit && editing?.field === field.id;
        const close = (focus = true) => {
          if (onEdit(null, editing) !== false && sheet && focus) anchor.current?.focus();
        };
        const edit = (cell: HTMLDivElement) => {
          if (!canEdit || active) return;
          anchor.current = cell;
          onEdit({ record: record.id, field: field.id, base: record });
        };
        return (
          <div key={field.id} role="gridcell" tabIndex={0}
            className={`bo-grid-cell ${localOnly && field.id === "name" ? "bo-local-name" : ""} ${inline && active ? "bo-inline-cell" : ""}`}
            data-row={index} data-col={column}
            aria-haspopup={openOnRowClick || (canEdit && !inline) ? "dialog" : undefined}
            aria-controls={active && !inline ? popupId : undefined}
            aria-expanded={canEdit && !inline ? active : undefined}
            onClick={event => edit(event.currentTarget)}
            onKeyDown={event => {
              if (event.target === event.currentTarget && (event.key === "Enter" || ((openOnRowClick || !inline) && event.key === " "))) {
                if (canEdit) { event.preventDefault(); edit(event.currentTarget); }
                else if (openOnRowClick || (field.id === "name" && !record.objectId.startsWith("@"))) {
                  event.preventDefault();
                  onOpen(record);
                }
              } else if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
                onMove(event, index, column);
              }
            }}
          >
            {inline && active && editing ? (
              <InlineCellEditor duration={isTimeDurationField(record.objectId, field.id)} preserveOnExit={sheet} commitUnchanged={sheet && record.revision === 0} field={field} value={valueFor(editing.base, field.id)}
                onSave={value => onSave(editing.base, { [field.id]: value })}
                onCancel={close} onError={onError}
                canTab={canTab && (backward => canTab(column, backward))}
                onTab={sheet ? event => onMove(event, index, column) : undefined} />
            ) : field.id === "name" ? (
              <><RecordChip record={record} onOpen={onOpen} />{localOnly && <small className="bo-local-label">{t("back_office.local_copy")}</small>}</>
            ) : (
              <ValueDisplay objectId={record.objectId} field={field} value={valueFor(record, field.id)}
                records={records} recordById={recordById} onOpen={onOpen} />
            )}
            {active && !inline && editing && (
              <Popover.Root open onOpenChange={open => { if (!open) onEdit(null, editing); }}>
                <Popover.Portal>
                  <Popover.Positioner anchor={anchor} align="start" side="bottom" sideOffset={-32}>
                    <DirectoryEditorPopup id={popupId} finalFocus={sheet ? false : anchor}
                      style={{ width: field.type === "date" ? "max-content" : field.type === "select" ? 200 : 260 }}>
                      <CellEditor projectScope={sheet ? "time-sheet" : undefined} record={editing.base} field={field}
                        value={valueFor(field.multiple || field.type === "multiselect" ? record : editing.base, field.id)} records={records}
                        allowedRelationIds={allowedRelationIds?.(editing.base, field.id)}
                        canTab={canTab && (backward => canTab(column, backward))}
                        onTab={sheet ? event => onMove(event, index, column) : undefined}
                        onCancel={close} onSave={(value, previous) => onSave(previous ? { ...editing.base, values: { ...editing.base.values, [field.id]: previous } } : editing.base, { [field.id]: value })} />
                    </DirectoryEditorPopup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}
          </div>
        );
      })}
      <div className={sheet ? "time-record-actions" : "bo-grid-fill"}>{trailing}</div>
      {details && <div className="bo-grid-row-details">{details}</div>}
    </div>
  );
});
