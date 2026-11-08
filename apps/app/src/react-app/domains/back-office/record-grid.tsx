import { RecordFilterEditor, recordFilterOperatorLabel, recordFilterValueLabel } from "./record-filter-editor";
import { BackOfficeFilesSchema, backOfficeViewFilters, compileBackOfficeFilters } from "@legalwork/types/back-office";
import { backOfficeViewLabel, backOfficeIconLabel } from "./labels";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useSearchParams } from "react-router-dom";
import { t } from "@/i18n";
import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Columns3,
  Table2,
  CalendarDays,
  Kanban,
  List,
  MoreHorizontal,
  BriefcaseBusiness,
  Building2,
  UsersRound,
  Tag,
  Plus,
  X,
} from "lucide-react";
import { Button, Checkbox, Input } from "twenty-ui/primitives/input";
import { Dropdown } from "twenty-ui/components/navigation";
import { SearchInput } from "twenty-ui/components/input";
import { Popover } from "twenty-ui/primitives/surfaces";
import type {
  BackOfficeField,
  BackOfficeObject,
  BackOfficeRecord,
  BackOfficeValue,
  BackOfficeView,
} from "@legalwork/types/back-office";
import { FieldIcon } from "./record-values";
import { RecordGridRow, type EditingCell } from "./record-grid-row";
import { RecordKanban, RecordCalendar, RecordList } from "./record-views";
import {
  DirectoryMenu,
  DirectorySelect,
  DirectoryDialog,
} from "./twenty-controls";

const viewIcons = {
  table: Table2,
  kanban: Kanban,
  calendar: CalendarDays,
  list: List,
  briefcase: BriefcaseBusiness,
  building: Building2,
  users: UsersRound,
  tag: Tag,
};
const viewTypes: BackOfficeView["type"][] = [
  "table",
  "kanban",
  "calendar",
  "list",
];
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
  people: ["name", "personType", "active", "email", "jobTitle", "company", "phone", "city"],
  companies: [
    "name",
    "organisationType",
    "domain",
    "industry",
    "registrationNumber",
    "contact",
    "city",
  ],
  clients: [
    "name",
    "clientNumber",
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
  onCreate: (values?: Record<string, BackOfficeValue>) => void;
  onSaveView: (view: BackOfficeView) => Promise<void>;
  archived: boolean;
  onArchivedChange: (archived: boolean) => void;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlViewId = searchParams.get("viewId");
  const initialView = views.find(
    (view) =>
      view.id === urlViewId && view.objectId === object.id && !view.archived,
  );
  const viewAnchor = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState(initialView?.query ?? "");
  const searchInput = useRef<HTMLInputElement>(null);
  const [sort, setSort] = useState({
    field: initialView?.sortField ?? "name",
    direction: initialView?.sortDirection ?? "asc",
  });
  const [columns, setColumns] = useState(
    initialView?.columns ??
      defaults[object.id] ??
      object.fields.slice(0, 7).map((field) => field.id),
  );
  const [widths, setWidths] = useState<Record<string, number>>(
    initialView?.widths ?? defaultWidths,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [filters, setFilters] = useState(() => backOfficeViewFilters(initialView));
  const [filterOpen, setFilterOpen] = useState(false);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [error, setError] = useState("");
  const [viewName, setViewName] = useState("");
  const [savingView, setSavingView] = useState(false);
  const [activeViewId, setActiveViewId] = useState<string | null>(
    initialView?.id ?? null,
  );
  const activeView = views.find(
    (view) =>
      view.id === activeViewId && view.objectId === object.id && !view.archived,
  );
  const [layout, setLayout] = useState<BackOfficeView["type"]>(
    initialView?.type ?? "table",
  );
  const [groupField, setGroupField] = useState<string | null>(
    initialView?.groupField ?? null,
  );
  const [dateField, setDateField] = useState<string | null>(
    initialView?.dateField ?? null,
  );
  const [calendarMode, setCalendarMode] = useState<
    BackOfficeView["calendarMode"]
  >(initialView?.calendarMode ?? "month");
  const [viewType, setViewType] = useState<BackOfficeView["type"]>("table");
  const [viewGroup, setViewGroup] = useState("");
  const [viewDate, setViewDate] = useState("createdAt");
  const [viewIcon, setViewIcon] = useState<BackOfficeView["icon"]>(null);
  const [editingView, setEditingView] = useState<BackOfficeView | null>(null);
  const [deletingView, setDeletingView] = useState<BackOfficeView | null>(null);
  const [viewMenu, setViewMenu] = useState(false);
  const groupingFields = object.fields.filter(
    (field) =>
      field.type === "select" || (field.type === "relation" && !field.multiple),
  );
  const dateFields = [
    ...object.fields
      .filter((field) => field.type === "date" || field.type === "datetime")
      .map((field) => ({ value: field.id, label: field.label })),
    { value: "createdAt", label: t("back_office.created_at") },
    { value: "updatedAt", label: t("back_office.updated_at") },
  ];
  const ActiveIcon = viewIcons[activeView?.icon ?? layout],
    CreateIcon = viewIcons[viewIcon ?? viewType];
  const beginView = (view?: BackOfficeView) => {
    setEditingView(view ?? null);
    setViewName(
      view?.name ?? t("back_office.all_records", { name: object.plural }),
    );
    setViewType(view?.type ?? "table");
    setViewGroup(
      view?.groupField ??
        groupField ??
        groupingFields.find((field) => field.id === "status")?.id ??
        groupingFields[0]?.id ??
        "",
    );
    setViewDate(view?.dateField ?? dateField ?? dateFields[0].value);
    setViewIcon(view?.icon ?? null);
    setViewMenu(false);
    setSavingView(true);
    setError("");
  };
  const visibleFields = useMemo(() => columns.flatMap((id) => {
    const field = object.fields.find((field) => field.id === id);
    return field && (field.visibility !== "finance" || finance) ? [field] : [];
  }), [columns, object, finance]);
  const own = useMemo(
    () =>
      records.filter(
        (record) =>
          record.objectId === object.id &&
          Boolean(record.archivedAt) === archived,
      ),
    [records, object.id, archived],
  );
  const recordById = useMemo(() => new Map(records.map(record => [record.id, record])), [records]);
  const fieldById = useMemo(() => new Map(object.fields.map(field => [field.id, field])), [object]);
  const display = useCallback((record: BackOfficeRecord, id: string) => {
    const value = record.values[id],
      field = fieldById.get(id);
    if (field?.type === "file") {
      const files = BackOfficeFilesSchema.safeParse(value);
      return files.success ? files.data.map((file) => file.name).join(" ") : "";
    }
    if (field?.type === "relation")
      return (Array.isArray(value) ? value : [value])
        .map(
          (id) => typeof id === "string" ? recordById.get(id)?.values.name ?? "" : "",
        )
        .join(" ");
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value.amountMinor
      : String(value ?? "");
  }, [fieldById, recordById]);
  const searchRows = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return own;
    return own.filter(record => object.fields.some(field =>
      String(display(record, field.id)).toLocaleLowerCase().includes(term)));
  }, [own, query, object, display]);
  const collator = useMemo(() => new Intl.Collator(undefined, { numeric: true }), []);
  const rows = useMemo(() => searchRows.filter(compileBackOfficeFilters(object, filters)).sort((a, b) => {
    const left = display(a, sort.field), right = display(b, sort.field);
    const order = typeof left === "number" && typeof right === "number"
      ? left - right : collator.compare(String(left), String(right));
    return sort.direction === "asc" ? order : -order;
  }), [searchRows, object, filters, sort, collator, display]);
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const selectedCount = useMemo(() => rows.reduce((sum, row) => sum + Number(selectedIds.has(row.id)), 0), [rows, selectedIds]);
  const scroll = useRef<HTMLDivElement>(null);
  const editingIndex = editing ? rows.findIndex(row => row.id === editing.record) : -1;
  // Small tables can scroll entirely on the compositor, even during a fast reversal.
  const windowed = rows.length > 120 || rows.length * visibleFields.length > 1200;
  const bufferedRange = useCallback((range: Range) => {
    const visible = range.endIndex - range.startIndex + 1;
    const indices = defaultRangeExtractor({ ...range, overscan: Math.ceil(visible * 1.5) });
    if (editingIndex >= 0 && editingIndex < indices[0]) indices.unshift(editingIndex);
    if (editingIndex > indices[indices.length - 1]) indices.push(editingIndex);
    return indices;
  }, [editingIndex]);
  const rowWindow = useVirtualizer({
    count: rows.length,
    enabled: layout === "table" && windowed,
    getScrollElement: () => scroll.current,
    getItemKey: useCallback((index: number) => rows[index].id, [rows]),
    estimateSize: () => 33,
    scrollMargin: 32,
    scrollPaddingStart: 32,
    rangeExtractor: bufferedRange,
  });
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [query, sort, filters, archived, activeViewId]);

  const bulkArchive = async () => {
    setError("");
    try {
      for (const record of rows.filter((record) =>
        selectedIds.has(record.id),
      ))
        await onSave(record, {}, !archived);
      setSelected([]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "The update failed.");
    }
  };
  const kanbanField = object.fields.find((field) => field.id === groupField);
  const template = `32px ${visibleFields.map((field) => `${widths[field.id] ?? (field.type === "relation" ? 185 : 144)}px`).join(" ")} 32px minmax(0,1fr)`;
  const saveView = async () => {
    if (!viewName.trim()) return;
    try {
      const view: BackOfficeView = {
        id: editingView?.id ?? crypto.randomUUID(),
        objectId: object.id,
        name: viewName.trim(),
        type: viewType,
        groupField: viewType === "kanban" ? viewGroup : null,
        dateField: viewType === "calendar" ? viewDate : null,
        calendarMode: editingView?.calendarMode ?? calendarMode,
        icon: viewIcon,
        archived: false,
        columns: editingView?.columns ?? columns,
        widths: editingView?.widths ?? widths,
        query: editingView?.query ?? query,
        filters: editingView?.filters ?? {},
        filterCriteria: editingView ? backOfficeViewFilters(editingView) : filters,
        sortField: editingView?.sortField ?? sort.field,
        sortDirection:
          editingView?.sortDirection ??
          (sort.direction === "desc" ? "desc" : "asc"),
      };
      await onSaveView(view);
      applyView(view);
      setSavingView(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save view.");
    }
  };
  const applyView = (view?: BackOfficeView, updateUrl = true) => {
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
    setFilters(backOfficeViewFilters(view));
    if (updateUrl)
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (view) next.set("viewId", view.id);
          else next.delete("viewId");
          return next;
        },
        { replace: true },
      );
    setActiveViewId(view?.id ?? null);
    setLayout(view?.type ?? "table");
    setGroupField(view?.groupField ?? null);
    setDateField(view?.dateField ?? null);
    setCalendarMode(view?.calendarMode ?? "month");
    setSelected([]);
    setEditing(null);
  };
  useEffect(() => {
    if (urlViewId !== activeViewId || (activeViewId && !activeView))
      applyView(
        views.find(
          (view) =>
            view.id === urlViewId &&
            view.objectId === object.id &&
            !view.archived,
        ),
        false,
      );
  }, [urlViewId]);
  useEffect(() => {
    if (
      activeViewId &&
      !views.some((view) => view.id === activeViewId && !view.archived)
    )
      applyView();
  }, [views]);
  const selectRow = useCallback((id: string, checked: boolean) => {
    setSelected(current => checked ? [...current, id] : current.filter(value => value !== id));
  }, []);
  const moveCell = useCallback((
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
      const targetRow = row + shift[0], targetColumn = column + shift[1];
      if (targetRow < 0 || targetRow >= rows.length || targetColumn < 0 || targetColumn >= visibleFields.length) return;
      const selector = `[data-row="${targetRow}"][data-col="${targetColumn}"]`;
      const cell = scroll.current?.querySelector<HTMLElement>(selector);
      if (cell) cell.focus();
      else {
        rowWindow.scrollToIndex(targetRow);
        requestAnimationFrame(() => scroll.current?.querySelector<HTMLElement>(selector)?.focus());
      }
    }
  }, [rows.length, visibleFields.length, rowWindow]);
  const summaryCells = useMemo(() => layout !== "table" ? null : visibleFields.map((field) => {
    const amounts = field.type !== "currency" ? [] : rows.flatMap((record) => {
      const value = record.values[field.id];
      return value &&
        typeof value === "object" &&
        !Array.isArray(value)
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
            amounts.reduce(
              (sum, value) => sum + value.amountMinor,
              0,
            ) / 100,
          )
        ) : null}
      </div>
    );
  }), [layout, rows, visibleFields]);
  const renderRow = (record: BackOfficeRecord, index: number, top?: number) => (
    <RecordGridRow key={record.id} record={record} index={index} top={top}
      measure={windowed ? rowWindow.measureElement : undefined} template={template}
      fields={visibleFields} records={records} recordById={recordById}
      userId={userId} editable={editable} selected={selectedIds.has(record.id)}
      editingField={editing?.record === record.id ? editing.field : undefined}
      onEdit={setEditing} onError={setError} onSelect={selectRow} onMove={moveCell}
      onSave={onSave} onOpen={onOpen} />
  );
  const viewProps = {
    rows, records, fields: visibleFields, editable: editable && !archived,
    userId, onSave, onOpen, onCreate,
  };
  return (
    <div className="bo-record-grid">
      <div className="bo-view-toolbar">
        <DirectoryMenu
          align="start"
          open={viewMenu}
          onOpenChange={setViewMenu}
          className="bo-view-menu"
          trigger={
            <Button
              size="sm"
              variant="ghost"
              ref={viewAnchor}
              startIcon={<ActiveIcon size={14} />}
              endIcon={<ChevronDown size={12} />}
            >
              {activeView?.name ||
                t("back_office.all_records", { name: object.plural })}
              <span className="bo-view-count">· {rows.length}</span>
            </Button>
          }
        >
          <Dropdown.ActionItem
            startIcon={<Table2 size={14} />}
            onClick={() => applyView()}
          >
            {t("back_office.all_records", { name: object.plural })}
          </Dropdown.ActionItem>
          {views
            .filter((view) => view.objectId === object.id && !view.archived)
            .map((view) => {
              const Icon = viewIcons[view.icon ?? view.type];
              return (
                <div className="bo-saved-view-row" key={view.id}>
                  <Dropdown.ActionItem
                    startIcon={<Icon size={14} />}
                    onClick={() => applyView(view)}
                  >
                    {view.name}
                  </Dropdown.ActionItem>
                  {editable && (
                    <DirectoryMenu
                      align="start"
                      trigger={
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("back_office.view_options", {
                            name: view.name,
                          })}
                          startIcon={<MoreHorizontal size={13} />}
                        />
                      }
                    >
                      <Dropdown.ActionItem onClick={() => beginView(view)}>
                        {t("back_office.edit_view")}
                      </Dropdown.ActionItem>
                      <Dropdown.ActionItem
                        onClick={() => {
                          setViewMenu(false);
                          setDeletingView(view);
                        }}
                      >
                        {t("back_office.delete_view")}
                      </Dropdown.ActionItem>
                    </DirectoryMenu>
                  )}
                </div>
              );
            })}
          {editable && (
            <>
              <Dropdown.Separator />
              <Dropdown.ActionItem
                startIcon={<Plus size={14} />}
                onClick={() => beginView()}
              >
                {t("back_office.add_view")}
              </Dropdown.ActionItem>
            </>
          )}
        </DirectoryMenu>
        <div className="bo-view-actions">
          <div className="bo-search">
            <SearchInput
              ref={searchInput}
              size="sm"
              aria-label={t("back_office.search_records")}
              placeholder={t("back_office.search_records")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              actions={query ? <Button size="sm" type="button" variant="ghost" color="neutral" aria-label={t("integrations.clear_search")} startIcon={<X size={12} />} onClick={() => { setQuery(""); searchInput.current?.focus({ preventScroll: true }); }} /> : undefined}
            />
          </div>
          <DirectoryMenu type="panel" className="bo-record-filter-popup" open={filterOpen} onOpenChange={setFilterOpen} trigger={
            <Button size="sm" variant="ghost" color="neutral">{t("back_office.filters.button")}{filters.conditions.length > 0 && <span className="bo-filter-count">{filters.conditions.length}</span>}</Button>
          }>
            <RecordFilterEditor key={String(filterOpen)} object={object} records={records} rows={searchRows} finance={finance} value={filters} onCancel={() => setFilterOpen(false)} onApply={next => { setFilters(next); setFilterOpen(false); }} />
          </DirectoryMenu>
          <DirectoryMenu
            trigger={
              <Button size="sm" variant="ghost">
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
            {activeView && editable && (
              <Dropdown.ActionItem
                onClick={() =>
                  void onSaveView({
                    ...activeView,
                    columns,
                    widths,
                    query,
                    filters: {},
                    filterCriteria: filters,
                    sortField: sort.field,
                    sortDirection: sort.direction === "desc" ? "desc" : "asc",
                    calendarMode,
                  }).catch((error) => setError(error.message))
                }
              >
                {t("back_office.save_view")}
              </Dropdown.ActionItem>
            )}
            <Dropdown.Separator />
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
              <Dropdown.ActionItem onClick={() => beginView()}>
                {t("back_office.add_view")}
              </Dropdown.ActionItem>
            )}
          </DirectoryMenu>
        </div>
      </div>
      {selectedCount > 0 && (
        <div className="bo-selection-bar">
          <span>{selectedCount} selected</span>
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
      {filters.conditions.length > 0 && <div className="bo-filter-chips" aria-label={t("back_office.filters.active")}>
        {filters.conditions.length > 1 && <span className="bo-muted">{t(filters.mode === "all" ? "projects.reference.all_rules" : "projects.reference.any_rule")}</span>}
        {filters.conditions.map((condition, index) => {
          const field = object.fields.find(field => field.id === condition.fieldId);
          const label = `${field?.label ?? condition.fieldId} ${recordFilterOperatorLabel(condition.operator, field)} ${recordFilterValueLabel(condition, object, records)}`.trim();
          return <Button key={index} type="button" size="sm" variant="outline" color="neutral" title={label} aria-label={t("back_office.filters.remove", { name: label })} endIcon={<X size={12} />} onClick={() => setFilters(current => ({ ...current, conditions: current.conditions.filter((_, i) => i !== index) }))}><span>{label}</span></Button>;
        })}
      </div>}
      {layout === "kanban" && kanbanField ? (
        <RecordKanban {...viewProps} field={kanbanField} />
      ) : layout === "calendar" ? (
        <RecordCalendar
          {...viewProps}
          allFields={object.fields}
          dateField={dateField ?? "createdAt"}
          mode={calendarMode}
          onModeChange={(mode) => {
            setCalendarMode(mode);
            if (activeView)
              void onSaveView({ ...activeView, calendarMode: mode }).catch(
                (error) => setError(error.message),
              );
          }}
        />
      ) : layout === "list" ? (
        <RecordList {...viewProps} />
      ) : (
        <div
          className="bo-grid-scroll"
          ref={scroll}
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
                  selectedCount === rows.length
                }
                indeterminate={
                  selectedCount > 0 && selectedCount < rows.length
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
                        current.field === field.id &&
                        current.direction === "asc"
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
                          sort.direction === "asc"
                            ? "rotate(180deg)"
                            : undefined,
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
                onClick={() =>
                  (window.location.hash = "/back-office/data-model")
                }
              />
            </div>
            <div className="bo-grid-fill" />
            <div className="bo-grid-fill" />
          </div>
          <div className={windowed ? "bo-windowed-rows" : undefined}
            style={windowed ? { height: rowWindow.getTotalSize() } : undefined}>
            {windowed
              ? rowWindow.getVirtualItems().map(item => renderRow(rows[item.index], item.index, item.start - 32))
              : rows.map((record, index) => renderRow(record, index))}
          </div>
          {!rows.length && (
            <div className="bo-empty">
              <Columns3 size={26} />
              <strong>
                {query || filters.conditions.length > 0
                  ? "No matching records"
                  : `Start with your ${object.plural.toLocaleLowerCase()}`}
              </strong>
              <span>
                {query || filters.conditions.length > 0
                  ? "Adjust your search or filters."
                  : `Add your first ${object.label.toLocaleLowerCase()} or import a CSV file.`}
              </span>
              {editable && !query && (
                <Button
                  size="sm"
                  variant="solid"
                  color="accent"
                  startIcon={<Plus size={14} />}
                  onClick={() => onCreate()}
                >
                  Create {object.label}
                </Button>
              )}
            </div>
          )}
          {editable && !archived && (
            <button className="bo-add-row" onClick={() => onCreate()}>
              <Plus size={15} />
              Add New
            </button>
          )}
          <div
            className="bo-grid-summary"
            style={{ gridTemplateColumns: template }}
          >
            <div />
            {summaryCells}
          </div>
        </div>
      )}
      <Popover.Root open={savingView} onOpenChange={setSavingView}>
        <Popover.Portal>
          <Popover.Positioner anchor={viewAnchor} align="start" sideOffset={4}>
            <Popover.Popup className="bo-view-editor">
              <div className="bo-view-editor-header">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("common.close")}
                  startIcon={<X size={12} />}
                  onClick={() => setSavingView(false)}
                />
                <Popover.Title className="bo-view-editor-title">
                  {t(
                    editingView
                      ? "back_office.edit_view"
                      : "back_office.create_view",
                  )}
                </Popover.Title>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveView();
                }}
              >
                <div className="bo-view-editor-name">
                  <DirectoryMenu
                    align="start"
                    trigger={
                      <Button
                        className="bo-view-editor-icon"
                        size="sm"
                        variant="outline"
                        aria-label={t("back_office.view_icon")}
                        startIcon={<CreateIcon size={15} />}
                      />
                    }
                  >
                    {Object.entries(viewIcons).map(([key, Icon]) => (
                      <Dropdown.ActionItem
                        key={key}
                        startIcon={<Icon size={15} />}
                        onClick={() => {
                          if (
                            key === "table" ||
                            key === "kanban" ||
                            key === "calendar" ||
                            key === "list" ||
                            key === "briefcase" ||
                            key === "building" ||
                            key === "users" ||
                            key === "tag"
                          )
                            setViewIcon(key);
                        }}
                      >
                        {backOfficeIconLabel(key)}
                      </Dropdown.ActionItem>
                    ))}
                  </DirectoryMenu>
                  <Input
                    autoFocus
                    required
                    aria-label={t("back_office.view_name")}
                    placeholder={t("back_office.view_name")}
                    value={viewName}
                    onChange={(event) => setViewName(event.target.value)}
                  />
                </div>
                <div className="bo-view-editor-type">
                  <span>{t("back_office.view_type")}</span>
                  <DirectoryMenu
                    align="start"
                    trigger={
                      <Button
                        size="sm"
                        variant="outline"
                        startIcon={<CreateIcon size={15} />}
                        endIcon={<ChevronDown size={12} />}
                      >
                        {backOfficeViewLabel(viewType)}
                      </Button>
                    }
                  >
                    {viewTypes.map((type) => {
                      const Icon = viewIcons[type];
                      return (
                        <Dropdown.ActionItem
                          key={type}
                          startIcon={<Icon size={15} />}
                          disabled={
                            type === "kanban" && groupingFields.length === 0
                          }
                          onClick={() => {
                            setViewType(type);
                            setViewIcon(null);
                          }}
                        >
                          {backOfficeViewLabel(type)}
                        </Dropdown.ActionItem>
                      );
                    })}
                  </DirectoryMenu>
                </div>
                {viewType === "kanban" && (
                  <div className="bo-view-editor-type">
                    <span>{t("back_office.stages")}</span>
                    <DirectorySelect
                      label={t("back_office.stages")}
                      value={viewGroup}
                      onChange={setViewGroup}
                      options={groupingFields.map((field) => ({
                        value: field.id,
                        label: field.label,
                      }))}
                    />
                  </div>
                )}
                {viewType === "calendar" && (
                  <div className="bo-view-editor-type">
                    <span>{t("back_office.date_field")}</span>
                    <DirectorySelect
                      label={t("back_office.date_field")}
                      value={viewDate}
                      onChange={setViewDate}
                      options={dateFields}
                    />
                  </div>
                )}
                <div className="bo-view-editor-footer">
                  <Button
                    type="submit"
                    size="sm"
                    variant="solid"
                    color="accent"
                  >
                    {t(
                      editingView
                        ? "back_office.save_view"
                        : "back_office.create",
                    )}
                  </Button>
                </div>
              </form>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {deletingView && (
        <DirectoryDialog
          title={t("back_office.delete_view")}
          onClose={() => setDeletingView(null)}
        >
          <p>
            {t("back_office.delete_view_hint", { name: deletingView.name })}
          </p>
          <div className="bo-modal-footer">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeletingView(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              color="danger"
              variant="solid"
              onClick={() =>
                void onSaveView({ ...deletingView, archived: true })
                  .then(() => {
                    if (activeViewId === deletingView.id) applyView();
                    setDeletingView(null);
                  })
                  .catch((error) => setError(error.message))
              }
            >
              {t("back_office.delete_view")}
            </Button>
          </div>
        </DirectoryDialog>
      )}
    </div>
  );
}
