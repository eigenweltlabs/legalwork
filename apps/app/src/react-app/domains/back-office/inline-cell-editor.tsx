import { t } from "@/i18n";
import { cellInputText, parseCellInput } from "./cell-input";
import { useRef, useState, type KeyboardEvent } from "react";
import { Input } from "twenty-ui/primitives/input";
import type {
  BackOfficeField,
  BackOfficeValue,
} from "@legalwork/types/back-office";

export function InlineCellEditor({
  field,
  value,
  onSave,
  onCancel,
  onError,
  onTab,
  commitUnchanged = false,
}: {
  field: BackOfficeField;
  value: BackOfficeValue | undefined;
  onSave: (value: BackOfficeValue) => Promise<void>;
  onCancel: () => void;
  onError: (message: string) => void;
  commitUnchanged?: boolean;
  onTab?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const initial = field.type === "datetime" && typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : cellInputText(value);
  const [text, setText] = useState(initial);
  const completed = useRef(false);
  const commit = async () => {
    if (completed.current) return;
    completed.current = true;
    if (text === initial && !commitUnchanged) {
      onCancel();
      return true;
    }
    try {
      onError("");
      await onSave(parseCellInput(field.type, text, value));
      onCancel();
      return true;
    } catch (error) {
      completed.current = false;
      onError(
        error instanceof Error ? error.message : t("back_office.value_failed"),
      );
    }
  };
  return (
    <Input
      autoFocus
      size="sm"
      variant="plain"
      className="bo-inline-input"
      aria-label={field.label}
      value={text}
      type={
        field.type === "date" ? "date" : field.type === "datetime" ? "datetime-local" : field.type === "number" || field.type === "currency"
          ? "number"
          : field.type === "email"
            ? "email"
            : "text"
      }
      step="any"
      onFocus={(event) => event.target.select()}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => void commit()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Tab" && onTab) {
          event.preventDefault();
          void commit().then(saved => { if (saved) onTab(event); });
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          completed.current = true;
          onCancel();
        }
      }}
    />
  );
}
