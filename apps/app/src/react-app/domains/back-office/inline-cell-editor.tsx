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
  const initial =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? String(value.amountMinor / 100)
      : String(value ?? "");
  const [text, setText] = useState(initial);
  const completed = useRef(false);
  const commit = async () => {
    if (completed.current) return;
    completed.current = true;
    if (text === initial) {
      onCancel();
      return;
    }
    let next: BackOfficeValue = text || null;
    if (text && (field.type === "number" || field.type === "currency")) {
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) {
        onError("Enter a number.");
        onCancel();
        return;
      }
      next =
        field.type === "currency"
          ? {
              amountMinor: Math.round(numeric * 100),
              currency:
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value)
                  ? value.currency
                  : "EUR",
            }
          : numeric;
    }
    try {
      await onSave(next);
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
