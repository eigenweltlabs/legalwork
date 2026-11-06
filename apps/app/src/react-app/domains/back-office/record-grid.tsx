import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  ChevronDown,
  Columns3,
  Filter,
  Hash,
  Link2,
  LockKeyhole,
  Plus,
  Search,
  Tag as TagIcon,
  Type,
  X,
} from "lucide-react";
import { Avatar, Chip, Tag } from "twenty-ui/primitives/data-display";
import { Button, Checkbox, Input } from "twenty-ui/primitives/input";
import { Dropdown } from "twenty-ui/components/navigation";
import { Popover } from "twenty-ui/primitives/surfaces";
import type {
  BackOfficeField,
  BackOfficeObject,
  BackOfficeRecord,
  BackOfficeValue,
  BackOfficeView,
} from "@legalwork/types/back-office";
import { selectColor } from "./select-colors";
import { InlineCellEditor } from "./inline-cell-editor";
import { CellEditor } from "./cell-editor";
import { DirectoryMenu, DirectorySelect } from "./twenty-controls";

const defaults: Record<string, string[]> = {
  matters: [
    "name",
    "fileNumber",
    "clients",
    "status",
    "practiceArea",
    "leadLawyer",
    "openedOn",
  ],
  people: ["name", "email", "jobTitle", "company", "phone", "city"],
  companies: [
    "name",
    "domain",
    "industry",
    "registrationNumber",
    "contact",
    "city",
  ],
  clients: [
    "name",
    "clientNumber",
    "clientType",
    "company",
    "person",
    "billingEmail",
  ],
};
const defaultWidths: Record<string, number> = {
  name: 225,
  fileNumber: 116,
  clients: 207,
  status: 104,
  practiceArea: 136,
  leadLawyer: 131,
  openedOn: 112,
};
export function FieldIcon({ field }: { field: BackOfficeField }) {
  const Icon =
    field.type === "relation"
      ? Link2
      : field.type === "date" || field.type === "datetime"
        ? CalendarDays
        : field.type === "number" || field.type === "currency"
          ? Hash
          : field.type === "select" || field.type === "multiselect"
            ? TagIcon
            : field.visibility === "private"
              ? LockKeyhole
              : Type;
  return <Icon size={13} aria-hidden="true" />;
}
export function RecordChip({
  record,
  onOpen,
}: {
  record: BackOfficeRecord;
  onOpen: (record: BackOfficeRecord) => void;
}) {
  const name = String(record.values.name ?? "");
  return (
    <Chip
      size="sm"
      variant="soft"
      clickable
      maxWidth={240}
      startElement={
        <Avatar
          size="xs"
          shape={record.objectId === "people" ? "circle" : "square"}
          name={name}
          colorSeed={record.id}
        />
      }
      onClick={(event) => {
        event.stopPropagation();
        onOpen(record);
      }}
    >
      {name}
    </Chip>
  );
}
export function ValueDisplay({
  field,
  value,
  records,
  onOpen,
}: {
  field: BackOfficeField;
  value: BackOfficeValue | undefined;
  records: BackOfficeRecord[];
  onOpen: (record: BackOfficeRecord) => void;
}) {
  if (value === null || value === undefined || value === "") return null;
  if (field.type === "relation")
    return (
      <div className="bo-relation-values">
        {(Array.isArray(value) ? value : [value]).map((id) => {
          const record = records.find((record) => record.id === id);
          return record ? (
            <RecordChip key={record.id} record={record} onOpen={onOpen} />
          ) : null;
        })}
      </div>
    );
  if (field.type === "select")
    return <Tag color={selectColor(String(value))}>{String(value)}</Tag>;
  if (
    field.type === "currency" &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    return (
      <span className="bo-number">
        {new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: value.currency,
        }).format(value.amountMinor / 100)}
      </span>
    );
  if (field.type === "date" && typeof value === "string")
    return (
      <span>
        {new Date(value + "T12:00:00").toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })}
      </span>
    );
  if (field.type === "datetime" && typeof value === "string")
    return <span>{new Date(value).toLocaleString()}</span>;
  if (field.type === "boolean")
    return value ? <Check size={14} /> : <span className="bo-muted">No</span>;
  if (Array.isArray(value))
    return (
      <div className="bo-relation-values">
        {value.map((item) => (
          <Tag key={item} color="gray">
            {item}
          </Tag>
        ))}
      </div>
    );
  return <span className="bo-truncate">{String(value)}</span>;
}

export function RecordGrid({
  object,
  records,
  views,
  editable,
  finance,
  userId,
  onSave,
  onOpen,
  onCreate,
  onSaveView,
  archived,
  onArchivedChange,
}: {
  object: BackOfficeObject;
  records: BackOfficeRecord[];
  views: BackOfficeView[];
  editable: boolean;
  finance: boolean;
  userId: string;
  onSave: (
    record: BackOfficeRecord,
    patch: Record<string, BackOfficeValue>,
    archived?: boolean,
  ) => Promise<void>;
  onOpen: (record: BackOfficeRecord) => void;
  onCreate: () => void;
  onSaveView: (view: BackOfficeView) => Promise<void>;
  archived: boolean;
  onArchivedChange: (archived: boolean) => void;
}) {
  const viewAnchor = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ field: "name", direction: "asc" });
  const [columns, setColumns] = useState(
    defaults[object.id] ?? object.fields.slice(0, 7).map((field) => field.id),
  );
  const [widths, setWidths] = useState<Record<string, number>>(defaultWidths);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState({ field: "", value: "" });
  const [editing, setEditing] = useState<{
    record: string;
    field: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [viewName, setViewName] = useState("");
  const [savingView, setSavingView] = useState(false);
  const [activeView, setActiveView] = useState("");
  const visibleFields = columns.flatMap((id) => {
    const field = object.fields.find((field) => field.id === id);
    return field && (field.visibility !== "finance" || finance) ? [field] : [];
  });
  const own = useMemo(
    () =>
      records.filter(
        (record) =>
          record.objectId === object.id &&
          Boolean(record.archivedAt) === archived,
      ),
    [records, object.id, archived],
  );
  const display = (record: BackOfficeRecord, id: string) => {
    const value = record.values[id],
      field = object.fields.find((field) => field.id === id);
    if (field?.type === "relation")
      return (Array.isArray(value) ? value : [value])
        .map(
          (id) => records.find((record) => record.id === id)?.values.name ?? "",
        )
        .join(" ");
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value.amountMinor
      : String(value ?? "");
  };
  const rows = own
    .filter(
      (record) =>
        (!query ||
          object.fields.some((field) =>
            String(display(record, field.id))
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase()),
          )) &&
        (!filter.field ||
          !filter.value ||
          String(record.values[filter.field]) === filter.value),
    )
    .sort((a, b) => {
      const left = display(a, sort.field),
        right = display(b, sort.field);
      return (
        (typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), undefined, {
              numeric: true,
            })) * (sort.direction === "asc" ? 1 : -1)
      );
    });
  const bulkArchive = async () => {
    setError("");
    try {
      for (const record of rows.filter((record) =>
        selected.includes(record.id),
      ))
        await onSave(record, {}, !archived);
      setSelected([]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The update failed.");
    }
  };
  const template = `32px ${visibleFields.map((field) => `${widths[field.id] ?? (field.type === "relation" ? 185 : 144)}px`).join(" ")} 32px minmax(0,1fr)`;
  const saveView = async () => {
    if (!viewName.trim()) return;
    try {
      await onSaveView({
        id: crypto.randomUUID(),
        objectId: object.id,
        name: viewName.trim(),
        columns,
        widths,
        query,
        filters: filter.field ? { [filter.field]: filter.value } : {},
        sortField: sort.field,
        sortDirection: sort.direction === "desc" ? "desc" : "asc",
      });
      setActiveView(viewName.trim());
      setSavingView(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save view.");
    }
  };
  const applyView = (view?: BackOfficeView) => {
    setColumns(
      view?.columns ??
        defaults[object.id] ??
        object.fields.slice(0, 7).map((field) => field.id),
    );
    setWidths(view?.widths ?? defaultWidths);
    setQuery(view?.query ?? "");
    setSort({
      field: view?.sortField ?? "name",
      direction: view?.sortDirection ?? "asc",
    });
    const first = Object.entries(view?.filters ?? {})[0];
    setFilter({ field: first?.[0] ?? "", value: String(first?.[1] ?? "") });
    setActiveView(view?.name ?? "");
  };
  const moveCell = (
    event: KeyboardEvent<HTMLDivElement>,
    row: number,
    column: number,
  ) => {
    const shift =
      event.key === "ArrowDown"
        ? [1, 0]
        : event.key === "ArrowUp"
          ? [-1, 0]
          : event.key === "ArrowRight"
            ? [0, 1]
            : event.key === "ArrowLeft"
              ? [0, -1]
              : null;
    if (shift) {
      event.preventDefault();
      event.currentTarget
        .closest('[role="grid"]')
        ?.querySelector<HTMLElement>(
          `[data-row="${row + shift[0]}"][data-col="${column + shift[1]}"]`,
        )
        ?.focus();
    }
  };
  return (
    <div className="bo-record-grid">
      <div className="bo-view-toolbar">
        <DirectoryMenu
          align="start"
          trigger={
            <Button
              size="sm"
              variant="ghost"
              ref={viewAnchor}
              startIcon={<Columns3 size={14} />}
              endIcon={<ChevronDown size={12} />}
            >
              {activeView || `All ${object.plural}`}
              <span className="bo-view-count">· {rows.length}</span>
            </Button>
          }
        >
          <Dropdown.ActionItem
            startIcon={<Columns3 size={14} />}
            onClick={() => applyView()}
          >
            All {object.plural}
          </Dropdown.ActionItem>
          {views
            .filter((view) => view.objectId === object.id)
            .map((view) => (
              <Dropdown.ActionItem
                key={view.id}
                onClick={() => applyView(view)}
              >
                {view.name}
              </Dropdown.ActionItem>
            ))}
          {editable && (
            <>
              <Dropdown.Separator />
              <Dropdown.ActionItem
                startIcon={<Plus size={14} />}
                onClick={() => {
                  setSavingView(true);
                  setViewName("");
                }}
              >
                Save current view
              </Dropdown.ActionItem>
            </>
          )}
        </DirectoryMenu>
        <div className="bo-view-actions">
          <label className="bo-search">
            <Search size={14} />
            <Input
              size="sm"
              variant="plain"
              aria-label={`Search ${object.plural}`}
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <DirectoryMenu
            type="panel"
            trigger={
              <Button
                size="sm"
                variant="ghost"
                color={filter.value ? "accent" : "neutral"}
                startIcon={<Filter size={14} />}
              >
                Filter
              </Button>
            }
          >
            <Dropdown.Header>
              <Dropdown.Title>Filter records</Dropdown.Title>
            </Dropdown.Header>
            <div className="bo-filter-form">
              <DirectorySelect
                label="Filter field"
                value={filter.field}
                onChange={(field) => setFilter({ field, value: "" })}
                options={[
                  { value: "", label: "Choose field" },
                  ...object.fields
                    .filter((field) => field.type === "select")
                    .map((field) => ({ value: field.id, label: field.label })),
                ]}
              />
              <DirectorySelect
                label="Filter value"
                value={filter.value}
                onChange={(value) =>
                  setFilter((current) => ({ ...current, value }))
                }
                options={[
                  { value: "", label: "All values" },
                  ...(
                    object.fields.find((field) => field.id === filter.field)
                      ?.options ?? []
                  ).map((option) => ({ value: option, label: option })),
                ]}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFilter({ field: "", value: "" })}
              >
                Clear filter
              </Button>
            </div>
          </DirectoryMenu>
          <DirectoryMenu
            trigger={
              <Button
                size="sm"
                variant="ghost"
                startIcon={
                  sort.direction === "desc" ? (
                    <ArrowDown size={14} />
                  ) : (
                    <ArrowUp size={14} />
                  )
                }
              >
                Sort
              </Button>
            }
          >
            <Dropdown.Header>
              <Dropdown.Title>Sort by</Dropdown.Title>
            </Dropdown.Header>
            {visibleFields.map((field) => (
              <Dropdown.ActionItem
                key={field.id}
                startIcon={<FieldIcon field={field} />}
                endIcon={
                  sort.field === field.id ? <Check size={14} /> : undefined
                }
                onClick={() =>
                  setSort((current) => ({ ...current, field: field.id }))
                }
              >
                {field.label}
              </Dropdown.ActionItem>
            ))}
            <Dropdown.Separator />
            <Dropdown.ActionItem
              startIcon={<ArrowUp size={14} />}
              onClick={() =>
                setSort((current) => ({ ...current, direction: "asc" }))
              }
            >
              Ascending
            </Dropdown.ActionItem>
            <Dropdown.ActionItem
              startIcon={<ArrowDown size={14} />}
              onClick={() =>
                setSort((current) => ({ ...current, direction: "desc" }))
              }
            >
              Descending
            </Dropdown.ActionItem>
          </DirectoryMenu>
          <DirectoryMenu
            trigger={
              <Button size="sm" variant="ghost">
                Options
              </Button>
            }
          >
            <Dropdown.Header>
              <Dropdown.Title>Visible fields</Dropdown.Title>
            </Dropdown.Header>
            {object.fields
              .filter((field) => field.visibility !== "finance" || finance)
              .map((field) => (
                <Dropdown.OptionItem
                  key={field.id}
                  value={field.id}
                  indicator="checkbox"
                  selected={columns.includes(field.id)}
                  disabled={field.id === "name"}
                  closeOnSelect={false}
                  startIcon={<FieldIcon field={field} />}
                  onSelect={() =>
                    setColumns((current) =>
                      current.includes(field.id)
                        ? current.filter((id) => id !== field.id)
                        : [...current, field.id],
                    )
                  }
                >
                  {field.label}
                </Dropdown.OptionItem>
              ))}
            <Dropdown.Separator />
            <Dropdown.ActionItem onClick={() => onArchivedChange(!archived)}>
              {archived ? "Show active records" : "Show archive"}
            </Dropdown.ActionItem>
            {editable && (
              <Dropdown.ActionItem
                onClick={() => {
                  setSavingView(true);
                  setViewName("");
                }}
              >
                Save as view
              </Dropdown.ActionItem>
            )}
          </DirectoryMenu>
        </div>
      </div>
      {selected.length > 0 && (
        <div className="bo-selection-bar">
          <span>{selected.length} selected</span>
          {editable && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void bulkArchive()}
            >
              {archived ? "Restore" : "Archive"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear selection
          </Button>
        </div>
      )}
      {error && (
        <div className="bo-error" role="alert">
          {error}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setError("")}
            aria-label="Dismiss error"
            startIcon={<X size={14} />}
          />
        </div>
      )}
      <div
        className="bo-grid-scroll"
        role="grid"
        aria-label={object.plural}
        aria-rowcount={rows.length + 1}
      >
        <div
          className="bo-grid-header"
          role="row"
          style={{ gridTemplateColumns: template }}
        >
          <div className="bo-check-cell">
            <Checkbox
              size="sm"
              aria-label="Select all rows"
              checked={
                rows.length > 0 &&
                rows.every((row) => selected.includes(row.id))
              }
              indeterminate={
                selected.length > 0 &&
                !rows.every((row) => selected.includes(row.id))
              }
              onCheckedChange={(checked) =>
                setSelected(checked ? rows.map((row) => row.id) : [])
              }
            />
          </div>
          {visibleFields.map((field) => (
            <div
              className="bo-grid-heading"
              role="columnheader"
              key={field.id}
              draggable
              onDragStart={(event) =>
                event.dataTransfer.setData("text/plain", field.id)
              }
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const source = event.dataTransfer.getData("text/plain");
                if (!columns.includes(source) || source === field.id) return;
                setColumns((current) => {
                  const next = current.filter((id) => id !== source);
                  next.splice(next.indexOf(field.id), 0, source);
                  return next;
                });
              }}
            >
              <button
                onClick={() =>
                  setSort((current) => ({
                    field: field.id,
                    direction:
                      current.field === field.id && current.direction === "asc"
                        ? "desc"
                        : "asc",
                  }))
                }
              >
                <FieldIcon field={field} />
                <span>{field.label}</span>
                {sort.field === field.id && (
                  <ArrowDown
                    size={11}
                    style={{
                      transform:
                        sort.direction === "asc" ? "rotate(180deg)" : undefined,
                    }}
                  />
                )}
              </button>
              <div
                className="bo-column-resizer"
                onPointerDown={(event) => {
                  const start = event.clientX,
                    width =
                      event.currentTarget.parentElement?.getBoundingClientRect()
                        .width ?? 144;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const target = event.currentTarget;
                  const move = (next: PointerEvent) =>
                    setWidths((current) => ({
                      ...current,
                      [field.id]: Math.max(
                        88,
                        Math.min(600, width + next.clientX - start),
                      ),
                    }));
                  const end = () => {
                    target.removeEventListener("pointermove", move);
                    target.removeEventListener("pointerup", end);
                  };
                  target.addEventListener("pointermove", move);
                  target.addEventListener("pointerup", end);
                }}
              />
            </div>
          ))}
          <div className="bo-grid-heading">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Add field"
              startIcon={<Plus size={14} />}
              onClick={() => (window.location.hash = "/back-office/data-model")}
            />
          </div>
          <div className="bo-grid-fill" />
          <div className="bo-grid-fill" />
        </div>
        {rows.map((record, rowIndex) => (
          <div
            role="row"
            key={record.id}
            className={`bo-grid-row ${selected.includes(record.id) ? "bo-row-selected" : ""}`}
            style={{ gridTemplateColumns: template }}
          >
            <div className="bo-check-cell">
              <Checkbox
                size="sm"
                aria-label={`Select ${record.values.name}`}
                checked={selected.includes(record.id)}
                onCheckedChange={(checked) =>
                  setSelected((current) =>
                    checked
                      ? [...current, record.id]
                      : current.filter((id) => id !== record.id),
                  )
                }
              />
            </div>
            {visibleFields.map((field, columnIndex) => {
              const canEdit =
                editable &&
                (field.visibility !== "private" || record.ownerId === userId);
              if (
                field.id !== "name" &&
                ["text", "email", "number", "currency"].includes(field.type)
              ) {
                const active =
                  editing?.record === record.id && editing.field === field.id;
                return (
                  <div
                    key={field.id}
                    role="gridcell"
                    tabIndex={0}
                    className={`bo-grid-cell ${active ? "bo-inline-cell" : ""}`}
                    data-row={rowIndex}
                    data-col={columnIndex}
                    onClick={() => {
                      if (canEdit)
                        setEditing({ record: record.id, field: field.id });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && canEdit) {
                        event.preventDefault();
                        setEditing({ record: record.id, field: field.id });
                      } else moveCell(event, rowIndex, columnIndex);
                    }}
                  >
                    {active ? (
                      <InlineCellEditor
                        field={field}
                        value={record.values[field.id]}
                        onSave={(value) =>
                          onSave(record, { [field.id]: value })
                        }
                        onCancel={() => setEditing(null)}
                        onError={setError}
                      />
                    ) : (
                      <ValueDisplay
                        field={field}
                        value={record.values[field.id]}
                        records={records}
                        onOpen={onOpen}
                      />
                    )}
                  </div>
                );
              }
              return (
                <Popover.Root
                  key={field.id}
                  open={
                    editing?.record === record.id && editing.field === field.id
                  }
                  onOpenChange={(open) => {
                    if (canEdit)
                      setEditing(
                        open ? { record: record.id, field: field.id } : null,
                      );
                  }}
                >
                  <Popover.Trigger
                    render={
                      <div
                        role="gridcell"
                        tabIndex={0}
                        className="bo-grid-cell"
                        data-row={rowIndex}
                        data-col={columnIndex}
                        onKeyDown={(event) => {
                          const shift =
                            event.key === "ArrowDown"
                              ? [1, 0]
                              : event.key === "ArrowUp"
                                ? [-1, 0]
                                : event.key === "ArrowRight"
                                  ? [0, 1]
                                  : event.key === "ArrowLeft"
                                    ? [0, -1]
                                    : null;
                          if (shift) {
                            event.preventDefault();
                            event.currentTarget
                              .closest('[role="grid"]')
                              ?.querySelector<HTMLElement>(
                                `[data-row="${rowIndex + shift[0]}"][data-col="${columnIndex + shift[1]}"]`,
                              )
                              ?.focus();
                          }
                        }}
                      />
                    }
                  >
                    {field.id === "name" ? (
                      <RecordChip record={record} onOpen={onOpen} />
                    ) : (
                      <ValueDisplay
                        field={field}
                        value={record.values[field.id]}
                        records={records}
                        onOpen={onOpen}
                      />
                    )}
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Positioner
                      align="start"
                      side="bottom"
                      sideOffset={-32}
                    >
                      <Popover.Popup
                        className="bo-editor-popup"
                        style={{
                          width:
                            field.type === "date"
                              ? "max-content"
                              : field.type === "select"
                                ? 200
                                : 260,
                        }}
                      >
                        <CellEditor
                          key={record.id + field.id + record.revision}
                          field={field}
                          value={record.values[field.id]}
                          records={records}
                          onCancel={() => setEditing(null)}
                          onSave={(value) =>
                            onSave(record, { [field.id]: value })
                          }
                        />
                      </Popover.Popup>
                    </Popover.Positioner>
                  </Popover.Portal>
                </Popover.Root>
              );
            })}
            <div className="bo-grid-fill" />
          </div>
        ))}
        {!rows.length && (
          <div className="bo-empty">
            <Columns3 size={26} />
            <strong>
              {query || filter.value
                ? "No matching records"
                : `Start with your ${object.plural.toLocaleLowerCase()}`}
            </strong>
            <span>
              {query || filter.value
                ? "Adjust your search or filters."
                : `Add your first ${object.label.toLocaleLowerCase()} or import a CSV file.`}
            </span>
            {editable && !query && (
              <Button
                size="sm"
                variant="solid"
                color="accent"
                startIcon={<Plus size={14} />}
                onClick={onCreate}
              >
                Create {object.label}
              </Button>
            )}
          </div>
        )}
        {editable && !archived && (
          <button className="bo-add-row" onClick={onCreate}>
            <Plus size={15} />
            Add New
          </button>
        )}
        <div
          className="bo-grid-summary"
          style={{ gridTemplateColumns: template }}
        >
          <div />
          {visibleFields.map((field) => {
            const amounts = rows.flatMap((record) => {
              const value = record.values[field.id];
              return value && typeof value === "object" && !Array.isArray(value)
                ? [value]
                : [];
            });
            const currencies = [
              ...new Set(amounts.map((value) => value.currency)),
            ];
            return (
              <div key={field.id}>
                {field.id === "name" ? (
                  <span className="bo-muted">{rows.length} records</span>
                ) : field.type === "currency" && currencies.length === 1 ? (
                  new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: currencies[0],
                  }).format(
                    amounts.reduce((sum, value) => sum + value.amountMinor, 0) /
                      100,
                  )
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <Popover.Root open={savingView} onOpenChange={setSavingView}>
        <Popover.Portal>
          <Popover.Positioner anchor={viewAnchor} align="start" sideOffset={4}>
            <Popover.Popup className="bo-view-editor">
              <Popover.Title>Save view</Popover.Title>
              <form
                className="bo-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveView();
                }}
              >
                <label>
                  View name
                  <Input
                    autoFocus
                    required
                    value={viewName}
                    onChange={(event) => setViewName(event.target.value)}
                  />
                </label>
                <div className="bo-modal-footer">
                  <Button
                    type="submit"
                    size="sm"
                    variant="solid"
                    color="accent"
                  >
                    Save view
                  </Button>
                </div>
              </form>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
