import { cellInputText, parseCellInput } from "./cell-input";
import { useRef, useState } from "react";
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
}: {
  field: BackOfficeField;
  value: BackOfficeValue | undefined;
  onSave: (value: BackOfficeValue) => Promise<void>;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const initial = cellInputText(value);
  const [text, setText] = useState(initial);
  const completed = useRef(false);
  const commit = async () => {
    if (completed.current) return;
    completed.current = true;
    if (text === initial) {
      onCancel();
      return;
    }
    try {
      await onSave(parseCellInput(field.type, text, value));
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Could not save the value.",
      );
    } finally {
      onCancel();
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
        field.type === "number" || field.type === "currency"
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
