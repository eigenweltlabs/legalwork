import { memo } from "react";
import { FileValue } from "./record-files";
import {
  CalendarDays,
  Paperclip,
  Check,
  Hash,
  Link2,
  LockKeyhole,
  Tag as TagIcon,
  Type,
} from "lucide-react";
import { Avatar, Chip, Tag } from "twenty-ui/primitives/data-display";
import type {
  BackOfficeField,
  BackOfficeRecord,
  BackOfficeValue,
} from "@legalwork/types/back-office";
import { selectColor } from "./select-colors";
import { ObjectIcon } from "./object-icon";

export const FieldIcon = memo(function FieldIcon({ field }: { field: { type: BackOfficeField["type"]; visibility?: BackOfficeField["visibility"]; target?: string } }) {
  if (field.type === "relation" && field.target) return <ObjectIcon id={field.target} size={13} />;
  const Icon =
    field.type === "boolean"
      ? Check
      : field.type === "file"
        ? Paperclip
        : field.type === "relation"
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
});
export const RecordChip = memo(function RecordChip({
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
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(record);
      }}
    >
      {name}
    </Chip>
  );
});
export function ValueDisplay({
  field,
  value,
  records,
  recordById,
  onOpen,
}: {
  field: BackOfficeField;
  value: BackOfficeValue | undefined;
  records: BackOfficeRecord[];
  recordById?: ReadonlyMap<string, BackOfficeRecord>;
  onOpen: (record: BackOfficeRecord) => void;
}) {
  if (value === null || value === undefined || value === "") return null;
  if (field.type === "relation")
    return (
      <div className="bo-relation-values">
        {(Array.isArray(value) ? value : [value]).map((id) => {
          const record = recordById && typeof id === "string" ? recordById.get(id) : records.find(record => record.id === id);
          return record ? (
            <RecordChip key={record.id} record={record} onOpen={onOpen} />
          ) : null;
        })}
      </div>
    );
  return <FieldValue field={field} value={value} />;
}

const FieldValue = memo(function FieldValue({ field, value }: { field: BackOfficeField; value: NonNullable<BackOfficeValue> }) {
  if (field.type === "file") return <FileValue value={value} />;
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
          <Tag key={typeof item === "string" ? item : item.id} color="gray">
            {typeof item === "string" ? item : item.name}
          </Tag>
        ))}
      </div>
    );
  return <span className="bo-truncate">{String(value)}</span>;
});
