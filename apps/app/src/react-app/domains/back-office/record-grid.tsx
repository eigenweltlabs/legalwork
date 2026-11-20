import { RecordFilterEditor, recordFilterOperatorLabel, recordFilterValueLabel } from "./record-filter-editor";
import { BackOfficeFilesSchema, backOfficeMajorAmount, backOfficeViewFilters, compareBackOfficeMoney, compileBackOfficeFilters, sumBackOfficeMoney } from "@legalwork/types/back-office";
import { backOfficeViewLabel, backOfficeIconLabel } from "./labels";
import { toast } from "@/components/ui/sonner";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useSearchParams } from "react-router-dom";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
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
  localRows, localChoices, draft,
  views,
  editable,
  finance,
  userId,
  onSave,
  onOpen,
  onCreate,
  onSaveView,
  archived,
  sheet,
  onArchivedChange, lockedSchema = false, readOnlyFields,
}: {
  sheet?: {
    columns: string[];
    allowedRelationIds?: (record: BackOfficeRecord, field: string) => readonly string[] | undefined;
    widths?: Record<string, number>;
    onFocus?: (record: BackOfficeRecord) => void;
    fieldValue?: (record: BackOfficeRecord, fieldId: string) => BackOfficeValue | undefined;
    trailing?: (record: BackOfficeRecord) => ReactNode;
    blankId: string;
    leading?: (record: BackOfficeRecord) => ReactNode;
    details?: (record: BackOfficeRecord, columns: readonly string[]) => ReactNode;
  };
  lockedSchema?: boolean;
  readOnlyFields?: readonly string[];
  object: BackOfficeObject;
  records: BackOfficeRecord[];
  localRows?: BackOfficeRecord[];
  draft?: BackOfficeRecord | null;
  localChoices?: BackOfficeRecord[];
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
  onSaveView: (view: BackOfficeView, expected: BackOfficeView | null) => Promise<BackOfficeView>;
  archived: boolean;
  onArchivedChange: (archived: boolean) => void;
}) {
  const locale = useLocale();
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
      sheet?.columns ??
      defaults[object.id] ??
      object.fields.slice(0, 7).map((field) => field.id),
  );
  const [widths, setWidths] = useState<Record<string, number>>(
    initialView?.widths ?? { ...defaultWidths, ...sheet?.widths },
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [filters, setFilters] = useState(() => backOfficeViewFilters(initialView));
  const [filterOpen, setFilterOpen] = useState(false);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const editingRef = useRef<EditingCell | null>(null);
  const editCell = useCallback((next: EditingCell | null, expected?: EditingCell) => {
    if (expected && editingRef.current !== expected) return false;
    editingRef.current = next;
    setEditing(next);
    return true;
  }, []);
  const [archiving, setArchiving] = useState(false);
  const [viewName, setViewName] = useState("");
  const [savingView, setSavingView] = useState(false);
  const [activeViewId, setActiveViewId] = useState<string | null>(
    initialView?.id ?? null,
  );
  const [viewBase, setViewBase] = useState<BackOfficeView | null>(initialView ?? null);
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
  };
  const visibleFields = useMemo(() => [...new Set(columns)].flatMap((id) => {
    const field = object.fields.find((field) => field.id === id);
    return field && (field.visibility !== "finance" || finance) ? [field] : [];
  }), [columns, object, finance]);
  const localIds = useMemo(() => {
    if (!localRows?.length) return new Set<string>();
    const shared = new Set(records.map(record => record.id));
    return new Set(localRows.filter(record => !shared.has(record.id)).map(record => record.id));
  }, [localRows, records]);
  const own = useMemo(() => {
    const own = records.filter(record => record.objectId === object.id && Boolean(record.archivedAt) === archived);
    if (localRows?.length) own.push(...localRows.filter(row => row.objectId === object.id && Boolean(row.archivedAt) === archived && localIds.has(row.id)));
    if (draft && !archived && draft.objectId === object.id && !own.some(row => row.id === draft.id)) own.push(draft);
    return own;
  }, [records, object.id, archived, localRows, localIds, draft]);
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
      ? backOfficeMajorAmount(value)
      : String(value ?? "");
  }, [fieldById, recordById]);
  const searchRows = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return own;
    return own.filter(record => record.id === sheet?.blankId || object.fields.some(field =>
      String(display(record, field.id)).toLocaleLowerCase().includes(term)));
  }, [own, query, object, display, sheet?.blankId]);
  const collator = useMemo(() => new Intl.Collator(undefined, { numeric: true }), []);
  const rows = useMemo(() => searchRows.filter(record => record.id === sheet?.blankId || compileBackOfficeFilters(object, filters)(record)).sort((a, b) => {
    if (sheet) {
      if (a.id === sheet.blankId) return 1;
      if (b.id === sheet.blankId) return -1;
      return records.indexOf(a) - records.indexOf(b);
    }
    const left = display(a, sort.field), right = display(b, sort.field);
    const leftValue = a.values[sort.field], rightValue = b.values[sort.field];
    const order = leftValue && typeof leftValue === "object" && !Array.isArray(leftValue) && rightValue && typeof rightValue === "object" && !Array.isArray(rightValue)
      ? compareBackOfficeMoney(leftValue, rightValue) : collator.compare(String(left), String(right));
    return sort.direction === "asc" ? order : -order;
  }), [searchRows, object, filters, sort, collator, display, sheet, records]);
  const selectedIds = useMemo(() => new Set(selected), [selected]);
  const selectable = useMemo(() => rows.filter(record => record.revision > 0), [rows]);
  const selectedCount = useMemo(() => selectable.reduce((sum, row) => sum + Number(selectedIds.has(row.id)), 0), [selectable, selectedIds]);
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
    if (archiving) return;
    setArchiving(true);
    const failures: string[] = [];
    try {
      for (const record of selectable.filter(row => selectedIds.has(row.id))) {
        try {
          await onSave(record, {}, !archived);
          setSelected(ids => ids.filter(id => id !== record.id));
        } catch (error) {
          failures.push(String(record.values.name) + ": " + (error instanceof Error ? error.message : t("back_office.update_failed")));
        }
      }
      if (failures.length) toast.error(failures.join("\n"));
    } finally { setArchiving(false); }
  };
  const kanbanField = object.fields.find((field) => field.id === groupField);
  const template = `${sheet ? 56 : 32}px ${visibleFields.map((field) => `${widths[field.id] ?? (field.type === "relation" ? 185 : 144)}px`).join(" ")} 32px minmax(0,1fr)`;
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
      const saved = await onSaveView(view, editingView);
      applyView(saved);
      setSavingView(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("back_office.view_failed"));
    }
  };
  const applyView = (view?: BackOfficeView, updateUrl = true) => {
    setColumns(
      view?.columns ??
        sheet?.columns ??
        defaults[object.id] ??
        object.fields.slice(0, 7).map((field) => field.id),
    );
    setWidths(view?.widths ?? { ...defaultWidths, ...sheet?.widths });
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
    setViewBase(view ?? null);
    setLayout(sheet ? "table" : view?.type ?? "table");
    setGroupField(view?.groupField ?? null);
    setDateField(view?.dateField ?? null);
    setCalendarMode(view?.calendarMode ?? "month");
    setSelected([]);
    editCell(null);
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
    event: KeyboardEvent<HTMLElement>,
    row: number,
    column: number,
  ) => {
    if (sheet && event.key === "Tab") {
      const position = row * visibleFields.length + column + (event.shiftKey ? -1 : 1);
      const targetRow = Math.floor(position / visibleFields.length), targetColumn = position % visibleFields.length;
      if (targetRow < 0 || targetRow >= rows.length) {
        // The last cell can commit a complete draft and add a new blank row.
        if (targetRow === rows.length && event.target instanceof HTMLInputElement) {
          requestAnimationFrame(() => {
            const next = scroll.current?.querySelector<HTMLElement>(`[data-row="${targetRow}"][data-col="${targetColumn}"]`)
              ?? scroll.current?.querySelector<HTMLElement>(`[data-sheet-blank]:not([data-record-id="${sheet.blankId}"]) [data-col="0"]`);
            if (next) { next.focus(); next.click(); }
          });
        }
        return;
      }
      event.preventDefault();
      editCell(null);
      if (windowed) rowWindow.scrollToIndex(targetRow);
      requestAnimationFrame(() => {
        const cell = scroll.current?.querySelector<HTMLElement>(`[data-row="${targetRow}"][data-col="${targetColumn}"]`);
        cell?.focus(); cell?.click();
      });
      return;
    }
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
  }, [rows, visibleFields, rowWindow, sheet, windowed, editCell]);
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
          <span className="bo-muted">{t("back_office.records_count", { count: rows.length })}</span>
        ) : field.type === "currency" && currencies.length === 1 ? (
          new Intl.NumberFormat(locale, {
            style: "currency",
            currency: currencies[0],
          }).format(sumBackOfficeMoney(amounts))
        ) : null}
      </div>
    );
  }), [layout, rows, visibleFields, locale]);
  const renderRow = (record: BackOfficeRecord, index: number, top?: number) => (
    <RecordGridRow key={record.id} sheet={Boolean(sheet)} blank={record.id === sheet?.blankId} fieldValue={sheet?.fieldValue} onFocus={() => sheet?.onFocus?.(record)} trailing={sheet?.trailing?.(record)} leading={sheet?.leading?.(record)} details={sheet?.details?.(record, columns)} record={record} index={index} top={top}
      measure={windowed ? rowWindow.measureElement : undefined} template={template}
      fields={visibleFields} records={localIds.has(record.id) ? localChoices ?? [] : records} recordById={localIds.has(record.id) ? undefined : recordById}
      readOnlyFields={readOnlyFields} userId={userId} localOnly={localIds.has(record.id)} editable={editable} selected={selectedIds.has(record.id)}
      allowedRelationIds={sheet?.allowedRelationIds}
      canTab={sheet ? (column, backward) => backward ? index > 0 || column > 0 : index < rows.length - 1 || column < visibleFields.length - 1 : undefined}
      editing={editing?.record === record.id ? editing : undefined}
      onEdit={editCell} onError={message => { if (message) toast.error(message); }} onSelect={selectRow} onMove={moveCell}
      onSave={onSave} onOpen={onOpen} />
  );
  const viewProps = {
    rows, records, localIds, localChoices, readOnlyFields, fields: visibleFields, editable: editable && !archived,
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
              <span className="bo-view-count">· {rows.filter(row => row.id !== sheet?.blankId).length}</span>
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
              <Button size="sm" variant="ghost" disabled={Boolean(sheet)}>
                {t("back_office.sort")}
              </Button>
            }
          >
            <Dropdown.Header>
              <Dropdown.Title>{t("review.sort_by")}</Dropdown.Title>
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
              {t("review.sort_asc")}
            </Dropdown.ActionItem>
            <Dropdown.ActionItem
              startIcon={<ArrowDown size={14} />}
              onClick={() =>
                setSort((current) => ({ ...current, direction: "desc" }))
              }
            >
              {t("review.sort_desc")}
            </Dropdown.ActionItem>
          </DirectoryMenu>
          <DirectoryMenu
            trigger={
              <Button size="sm" variant="ghost">
                {t("back_office.options")}
              </Button>
            }
          >
            <Dropdown.Header>
              <Dropdown.Title>{t("back_office.visible_fields")}</Dropdown.Title>
            </Dropdown.Header>
            {activeView && viewBase && editable && (
              <Dropdown.ActionItem
                onClick={() =>
                  void onSaveView({
                    ...viewBase,
                    columns,
                    widths,
                    query,
                    filters: {},
                    filterCriteria: filters,
                    sortField: sort.field,
                    sortDirection: sort.direction === "desc" ? "desc" : "asc",
                    calendarMode,
                  }, viewBase)
                    .then(saved => setViewBase(current => current?.id === saved.id ? saved : current))
                    .catch((error) => toast.error(error.message))
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
              {archived ? t("back_office.show_active_records") : t("back_office.show_archive")}
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
          <span>{t("back_office.selected_count", { count: selectedCount })}</span>
          {editable && (
            <Button
              size="sm"
              variant="ghost"
              disabled={archiving}
              onClick={() => void bulkArchive()}
            >
              {archived ? t("calendar.restore") : t("back_office.archive")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            {t("project_browser.clear_selection")}
          </Button>
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
            if (viewBase)
              void onSaveView({ ...viewBase, calendarMode: mode }, viewBase)
                .then(saved => setViewBase(current => current?.id === saved.id ? saved : current))
                .catch((error) => toast.error(error.message));
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
                aria-label={t("back_office.select_all")}
                disabled={!selectable.length}
                checked={
                  selectable.length > 0 &&
                  selectedCount === selectable.length
                }
                indeterminate={
                  selectedCount > 0 && selectedCount < selectable.length
                }
                onCheckedChange={(checked) =>
                  setSelected(checked ? selectable.map((row) => row.id) : [])
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
                  disabled={Boolean(sheet)}
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
                  {!sheet && sort.field === field.id && (
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
              {!lockedSchema && <Button
                size="sm"
                variant="ghost"
                aria-label={t("projects.add_field")}
                startIcon={<Plus size={14} />}
                onClick={() =>
                  (window.location.hash = "/back-office/data-model")
                }
              />}
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
          {!sheet && !rows.length && (
            <div className="bo-empty">
              <Columns3 size={26} />
              <strong>
                {query || filters.conditions.length > 0
                  ? t("back_office.no_matches")
                  : t("back_office.start_records", { name: object.plural })}
              </strong>
              <span>
                {query || filters.conditions.length > 0
                  ? t("back_office.adjust_search")
                  : t("back_office.first_record", { name: object.plural })}
              </span>
              {editable && !query && (
                <Button
                  size="sm"
                  variant="solid"
                  color="accent"
                  startIcon={<Plus size={14} />}
                  onClick={() => onCreate()}
                >
                  {t("back_office.create.title", { name: object.label })}
                </Button>
              )}
            </div>
          )}
          {editable && !archived && !sheet && (
            <button className="bo-add-row" onClick={() => onCreate()}>
              <Plus size={15} />
              {t("back_office.add_new")}
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
                    {(sheet ? viewTypes.filter(type => type === "table") : viewTypes).map((type) => {
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
                void onSaveView({ ...deletingView, archived: true }, deletingView)
                  .then(() => {
                    if (activeViewId === deletingView.id) applyView();
                    setDeletingView(null);
                  })
                  .catch((error) => toast.error(error.message))
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
