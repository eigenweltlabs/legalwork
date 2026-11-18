import { t } from "@/i18n";
import { cellInputText, parseCellInput } from "./cell-input";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
  canTab,
  commitUnchanged = false,
  preserveOnExit = false,
}: {
  field: BackOfficeField;
  value: BackOfficeValue | undefined;
  onSave: (value: BackOfficeValue) => Promise<void>;
  onCancel: (focus?: boolean) => void;
  onError: (message: string) => void;
  commitUnchanged?: boolean;
  preserveOnExit?: boolean;
  canTab?: (backward: boolean) => boolean;
  onTab?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const initial = field.type === "datetime" && typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : cellInputText(value);
  const [text, setText] = useState(initial);
  const completed = useRef(false);
  const draft = useRef({ field, value, text, initial, onSave, onError });
  draft.current = { field, value, text, initial, onSave, onError };
  useEffect(() => {
    if (!preserveOnExit) return;
    const unsaved = () => !completed.current && draft.current.text !== draft.current.initial;
    const warn = (event: BeforeUnloadEvent) => {
      if (!unsaved()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      if (!unsaved()) return;
      const draftCell = draft.current;
      const failed = (error: unknown) => draftCell.onError(error instanceof Error ? error.message : t("back_office.value_failed"));
      try { void draftCell.onSave(parseCellInput(draftCell.field.type, draftCell.text, draftCell.value)).catch(failed); }
      catch (error) { failed(error); }
    };
  }, [preserveOnExit]);
  const commit = async (focus = true) => {
    if (completed.current) return;
    completed.current = true;
    if (text === initial && !commitUnchanged) {
      onCancel(focus);
      return true;
    }
    try {
      onError("");
      await onSave(parseCellInput(field.type, text, value));
      onCancel(focus);
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
          const move = canTab?.(event.shiftKey) !== false;
          if (move) event.preventDefault();
          void commit(move).then(saved => { if (saved) onTab(event); });
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
