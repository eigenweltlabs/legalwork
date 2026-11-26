import { useTimeDurationFormat } from "./time-duration-controls";
import { formatTimeDuration, isTimeDurationField } from "./time-duration";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { backOfficeOptionLabel } from "./labels";
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
import { Chip, Tag } from "twenty-ui/primitives/data-display";
import { RecordAvatar as Avatar } from "./record-colors";
import {
  backOfficeMajorAmount,
  type BackOfficeField,
  type BackOfficeRecord,
  type BackOfficeValue,
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
  const synthetic = record.objectId.startsWith("@");
  return (
    <Chip
      className="bo-record-chip"
      size="sm"
      variant="soft"
      clickable={!synthetic}
      maxWidth={240}
      startElement={
        <Avatar
          size="xs"
          shape={synthetic || record.objectId === "people" ? "circle" : "square"}
          name={name}
          colorSeed={record.id}
        />
      }
      onPointerDown={synthetic ? undefined : (event) => event.stopPropagation()}
      onMouseDown={synthetic ? undefined : (event) => event.stopPropagation()}
      onClick={synthetic ? undefined : (event) => {
        event.stopPropagation();
        onOpen(record);
      }}
    >
      {name}
    </Chip>
  );
});
export function ValueDisplay({
  objectId,
  field,
  value,
  records,
  recordById,
  onOpen,
}: {
  objectId?: string;
  field: BackOfficeField;
  value: BackOfficeValue | undefined;
  records: BackOfficeRecord[];
  recordById?: ReadonlyMap<string, BackOfficeRecord>;
  onOpen: (record: BackOfficeRecord) => void;
}) {
  const format = useTimeDurationFormat();
  if (isTimeDurationField(objectId, field.id) && typeof value === "number") return <span>{formatTimeDuration(value, format)}</span>;
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
  const locale = useLocale();
  if (field.type === "file") return <FileValue value={value} />;
  if (field.type === "select")
    return <Tag color={selectColor(String(value))}>{backOfficeOptionLabel(field, String(value))}</Tag>;
  if (
    field.type === "currency" &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    return (
      <span className="bo-number">
        {new Intl.NumberFormat(locale, {
          style: "currency",
          currency: value.currency,
        }).format(backOfficeMajorAmount(value))}
      </span>
    );
  if ((field.type === "date" || (field.type === "datetime" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))) && typeof value === "string")
    return (
      <span>
        {new Date(value + "T12:00:00").toLocaleDateString(locale, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })}
      </span>
    );
  if (field.type === "datetime" && typeof value === "string")
    return <span>{new Date(value).toLocaleString(locale)}</span>;
  if (field.type === "boolean")
    return value ? <Check size={14} /> : <span className="bo-muted">{t("projects.reference.filter_false")}</span>;
  if (Array.isArray(value))
    return (
      <div className="bo-relation-values">
        {value.map((item) => (
          <Tag key={typeof item === "string" ? item : item.id} color={selectColor(typeof item === "string" ? item : item.name)}>
            {typeof item === "string" ? item : item.name}
          </Tag>
        ))}
      </div>
    );
  return <span className="bo-truncate">{String(value)}</span>;
});
