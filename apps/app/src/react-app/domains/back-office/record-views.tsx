import { useRecordDrag } from "./use-record-drag";
import { useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
} from "lucide-react";
import { Avatar, Tag } from "twenty-ui/primitives/data-display";
import { Button } from "twenty-ui/primitives/input";
import { Card, Popover } from "twenty-ui/primitives/surfaces";
import { DatePicker } from "twenty-ui/components/input";
import { ListItem } from "twenty-ui/primitives/navigation";
import type {
  BackOfficeField,
  BackOfficeRecord,
  BackOfficeValue,
  BackOfficeView,
} from "@legalwork/types/back-office";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { FieldIcon, ValueDisplay } from "./record-values";
import { CellEditor } from "./cell-editor";
import { DirectorySelect } from "./twenty-controls";
import { selectColor } from "./select-colors";
import {
  calendarDays,
  dayKey,
  groupViewRecords,
  moveCalendarDate,
  recordDay,
} from "@legalwork/types/back-office";

type Props = {
  rows: BackOfficeRecord[];
  records: BackOfficeRecord[];
  fields: BackOfficeField[];
  editable: boolean;
  userId: string;
  onOpen: (record: BackOfficeRecord) => void;
  onSave: (
    record: BackOfficeRecord,
    values: Record<string, BackOfficeValue>,
  ) => Promise<void>;
  onCreate: (values?: Record<string, BackOfficeValue>) => void;
};

function Property({
  record,
  field,
  props,
  placeholder = false,
}: {
  record: BackOfficeRecord;
  field: BackOfficeField;
  props: Props;
  placeholder?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const value = record.values[field.id];
  const content =
    value === null || value === undefined || value === "" ? (
      placeholder ? (
        <span className="bo-muted">{field.label}</span>
      ) : null
    ) : (
      <ValueDisplay
        field={field}
        value={value}
        records={props.records}
        onOpen={props.onOpen}
      />
    );
  if (
    !props.editable ||
    (field.visibility === "private" && record.ownerId !== props.userId)
  )
    return <span className="bo-record-property">{content}</span>;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            className="bo-record-property"
            aria-label={`${field.label}: ${String(value ?? "")}`}
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        {content}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={4}>
          <Popover.Popup className="bo-cell-popup">
            <CellEditor
              field={field}
              value={value}
              records={props.records}
              onSave={(value) => props.onSave(record, { [field.id]: value })}
              onCancel={() => setOpen(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Title({
  record,
  onOpen,
}: {
  record: BackOfficeRecord;
  onOpen: Props["onOpen"];
}) {
  const name = String(record.values.name ?? "");
  return (
    <button
      className="bo-record-title"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(record);
      }}
    >
      <Avatar
        size="xs"
        name={name}
        colorSeed={record.id}
        shape={record.objectId === "people" ? "circle" : "square"}
      />
      <span>{name}</span>
    </button>
  );
}

function RecordCard({
  record,
  props,
  draggable,
  drag,
}: {
  record: BackOfficeRecord;
  props: Props;
  draggable: boolean;
  drag?: ReturnType<typeof useRecordDrag>;
}) {
  return (
    <Card.Root
      variant="compact"
      className="bo-record-card"
      draggable={false}
      data-draggable={draggable || undefined}
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (draggable) drag?.start(record, event);
      }}
      onClickCapture={drag?.preventClick}
    >
      <Title record={record} onOpen={props.onOpen} />
      <div className="bo-record-card-properties">
        {props.fields
          .filter((field) => field.id !== "name")
          .map((field) => (
            <div key={field.id} className="bo-record-card-property">
              <FieldIcon field={field} />
              <Property
                record={record}
                field={field}
                props={props}
                placeholder
              />
            </div>
          ))}
      </div>
    </Card.Root>
  );
}

export function RecordList(props: Props) {
  return (
    <div className="bo-record-list" role="list">
      {props.rows.map((record) => (
        <ListItem
          key={record.id}
          className="bo-record-list-row"
          render={<div role="listitem" />}
          actionsVisibility="always"
          actions={
            <div className="bo-record-list-properties">
              {props.fields
                .filter((field) => field.id !== "name")
                .map((field) => (
                  <Property
                    key={field.id}
                    record={record}
                    field={field}
                    props={props}
                  />
                ))}
            </div>
          }
        >
          <Title record={record} onOpen={props.onOpen} />
        </ListItem>
      ))}
      {props.editable && (
        <button className="bo-add-row" onClick={() => props.onCreate()}>
          <Plus size={14} />
          {t("back_office.add_new")}
        </button>
      )}
    </div>
  );
}

export function RecordKanban({
  field,
  ...props
}: Props & { field: BackOfficeField }) {
  const [error, setError] = useState("");
  const [moving, setMoving] = useState(false);
  const groups = groupViewRecords(props.rows, field, props.records);
  const drag = useRecordDrag((record, target) => {
    const group = groups.find(
      (group) => JSON.stringify(group.value) === target,
    );
    if (
      !props.editable ||
      moving ||
      !group ||
      !props.rows.some((row) => row.id === record.id) ||
      (record.values[field.id] || null) === group.value
    )
      return;
    setMoving(true);
    setError("");
    void props
      .onSave(record, { [field.id]: group.value })
      .catch((error) => setError(error.message))
      .finally(() => setMoving(false));
  });
  return (
    <div className="bo-kanban-wrap">
      {drag.preview}
      {error && (
        <p role="alert" className="bo-error">
          {error}
        </p>
      )}
      <div className="bo-kanban" aria-label={field.label}>
        {groups.map((group) => (
          <section
            key={group.value ?? "__empty"}
            className={`bo-kanban-column ${drag.over === JSON.stringify(group.value) ? "bo-drop-target" : ""}`}
            data-bo-drop={
              props.editable ? JSON.stringify(group.value) : undefined
            }
            aria-label={group.label || t("back_office.no_value")}
          >
            <header>
              {group.value === null ? (
                <span className="bo-no-value">{t("back_office.no_value")}</span>
              ) : field.type === "select" ? (
                <Tag color={selectColor(group.label)}>{group.label}</Tag>
              ) : (
                <span>{group.label || t("back_office.unavailable")}</span>
              )}
              <span className="bo-muted">{group.records.length}</span>
            </header>
            {group.records.map((record) => (
              <RecordCard
                key={record.id}
                record={record}
                props={props}
                draggable={props.editable && !moving}
                drag={drag}
              />
            ))}
            {props.editable && (
              <button
                className="bo-add-row"
                onClick={() => props.onCreate({ [field.id]: group.value })}
              >
                <Plus size={14} />
                {t("back_office.new")}
              </button>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

export function RecordCalendar({
  dateField,
  allFields,
  mode,
  onModeChange,
  ...props
}: Props & {
  dateField: string;
  allFields: BackOfficeField[];
  mode: BackOfficeView["calendarMode"];
  onModeChange: (mode: BackOfficeView["calendarMode"]) => void;
}) {
  const locale = useLocale();
  const [anchor, setAnchor] = useState(() => new Date());
  const [picker, setPicker] = useState(false);
  const [pickerMonth, setPickerMonth] = useState(dayKey(anchor).slice(0, 7));
  const [error, setError] = useState("");
  const [moving, setMoving] = useState(false);
  const field = allFields.find((field) => field.id === dateField);
  const dateEditable =
    props.editable &&
    field &&
    (field.type === "date" || field.type === "datetime");
  const drag = useRecordDrag((record, key) => {
    if (
      !dateEditable ||
      !field ||
      moving ||
      !props.rows.some((row) => row.id === record.id) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(key)
    )
      return;
    setMoving(true);
    setError("");
    void props
      .onSave(record, {
        [dateField]: moveCalendarDate(record.values[dateField], field, key),
      })
      .catch((error) => setError(error.message))
      .finally(() => setMoving(false));
  });
  const days = calendarDays(anchor, mode, locale === "de" ? 1 : 0),
    today = dayKey(new Date());
  const step = (direction: number) => {
    const next = new Date(anchor);
    if (mode === "month") {
      next.setDate(1);
      next.setMonth(next.getMonth() + direction);
    } else next.setDate(next.getDate() + direction * (mode === "week" ? 7 : 1));
    setAnchor(next);
    setPickerMonth(dayKey(next).slice(0, 7));
  };
  return (
    <div className="bo-calendar">
      {drag.preview}
      <div className="bo-calendar-toolbar">
        <DirectorySelect
          label={t("back_office.calendar_period")}
          value={mode}
          onChange={(value) => {
            if (value === "day" || value === "week" || value === "month")
              onModeChange(value);
          }}
          options={[
            { value: "day", label: t("back_office.day") },
            { value: "week", label: t("back_office.week") },
            { value: "month", label: t("back_office.month") },
          ]}
        />
        <Popover.Root open={picker} onOpenChange={setPicker}>
          <Popover.Trigger
            render={
              <Button
                size="sm"
                variant="outline"
                endIcon={<ChevronDown size={12} />}
              />
            }
          >
            {anchor.toLocaleDateString(locale, {
              month: "long",
              year: "numeric",
            })}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="start" sideOffset={4}>
              <Popover.Popup>
                <DatePicker
                  value={dayKey(anchor)}
                  onValueChange={(value) =>
                    setAnchor(new Date(value + "T12:00:00"))
                  }
                  onValueSelect={(value) => {
                    setAnchor(new Date(value + "T12:00:00"));
                    setPicker(false);
                  }}
                  viewedMonth={pickerMonth}
                  onViewedMonthChange={setPickerMonth}
                  locale={locale}
                  weekStart={locale === "de" ? 1 : 0}
                  previousMonthLabel={t("back_office.previous_period")}
                  nextMonthLabel={t("back_office.next_period")}
                  monthLabel={t("back_office.month")}
                  yearLabel={t("back_office.year")}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <div className="bo-calendar-navigation">
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("back_office.previous_period")}
            startIcon={<ChevronLeft size={13} />}
            onClick={() => step(-1)}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const date = new Date();
              setAnchor(date);
              setPickerMonth(dayKey(date).slice(0, 7));
            }}
          >
            {t("back_office.today")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("back_office.next_period")}
            startIcon={<ChevronRight size={13} />}
            onClick={() => step(1)}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="bo-error">
          {error}
        </p>
      )}
      <div
        className="bo-calendar-weekdays"
        style={{
          gridTemplateColumns: `repeat(${mode === "day" ? 1 : 7},minmax(0,1fr))`,
        }}
      >
        {days.slice(0, mode === "day" ? 1 : 7).map((day) => (
          <span key={dayKey(day)}>
            {day.toLocaleDateString(locale, { weekday: "short" })}
          </span>
        ))}
      </div>
      <div
        className="bo-calendar-grid"
        style={{
          gridTemplateColumns: `repeat(${mode === "day" ? 1 : 7},minmax(0,1fr))`,
          gridTemplateRows: `repeat(${mode === "month" ? days.length / 7 : 1},minmax(180px,1fr))`,
        }}
      >
        {days.map((day) => {
          const key = dayKey(day);
          return (
            <section
              key={key}
              className={`bo-calendar-day ${day.getMonth() !== anchor.getMonth() ? "bo-other-month" : ""} ${drag.over === key ? "bo-drop-target" : ""}`}
              data-bo-drop={dateEditable ? key : undefined}
              aria-label={day.toLocaleDateString(locale)}
            >
              <header>
                {dateEditable && (
                  <button
                    aria-label={t("back_office.create_on_date", { date: key })}
                    onClick={() =>
                      field &&
                      props.onCreate({
                        [dateField]: moveCalendarDate(null, field, key),
                      })
                    }
                  >
                    <Plus size={13} />
                  </button>
                )}
                <span className={key === today ? "bo-calendar-today" : ""}>
                  {day.getDate()}
                </span>
              </header>
              {props.rows
                .filter((record) => recordDay(record, dateField) === key)
                .map((record) => (
                  <RecordCard
                    key={record.id}
                    record={record}
                    props={props}
                    draggable={Boolean(dateEditable) && !moving}
                    drag={drag}
                  />
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
