import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "@/i18n";

export function BillingEditCell({
  value,
  label,
  numeric,
  disabled,
  requireReason,
  cellId,
  revision,
  onEditing,
  onSave,
}: {
  value: string;
  label: string;
  numeric?: boolean;
  disabled?: boolean;
  requireReason?: boolean;
  cellId?: string;
  revision?: number;
  onEditing?: (cellId: string, active: boolean) => void;
  onSave: (value: string, reason?: string) => Promise<void>;
}) {
  const [edit, setEdit] = useState<{ initial: string; revision?: number; value: string } | null>(null);
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const reasonInput = useRef<HTMLInputElement>(null);
  const cancel = useRef(false);
  const editing = !!edit && !disabled;
  useEffect(() => {
    if (!editing || !cellId || !onEditing) return;
    onEditing(cellId, true);
    return () => onEditing(cellId, false);
  }, [editing, cellId, onEditing]);
  async function finish(returnFocus: boolean) {
    if (!edit || cancel.current || pending.current) return;
    const next = edit.value.trim();
    if ((!numeric && !next) || (numeric && !/^\d+$/.test(next))) {
      setMessage(
        t(numeric ? "back_office.billing.invalid_minutes" : "back_office.billing.required_text"),
      );
      return;
    }
    if (value !== edit.initial || revision !== edit.revision) {
      setMessage(t("back_office.billing.stale"));
      return;
    }
    if (requireReason && next !== value && !reason.trim()) {
      setMessage(t("back_office.billing.change_reason"));
      if (returnFocus) reasonInput.current?.focus();
      return;
    }
    pending.current = true;
    setSaving(true);
    setMessage("");
    try {
      if (next !== value) await onSave(next, reason.trim() || undefined);
      setEdit(null);
      if (returnFocus) requestAnimationFrame(() => anchor.current?.focus());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("back_office.billing.save_failed"));
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }
  function keys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void finish(true);
    }
    if (event.key === "Escape" && !pending.current) {
      event.preventDefault();
      cancel.current = true;
      setEdit(null);
      setMessage("");
      requestAnimationFrame(() => anchor.current?.focus());
    }
  }
  if (disabled) return <span>{value}</span>;
  return edit ? (
    <div
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) void finish(false);
      }}
    >
      <input
        aria-label={label}
        autoFocus
        readOnly={saving}
        value={edit.value}
        inputMode={numeric ? "numeric" : "text"}
        aria-invalid={!!message}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setEdit({ ...edit, value: event.currentTarget.value })}
        onKeyDown={keys}
      />
      {requireReason && value !== edit.value && (
        <input
          ref={reasonInput}
          readOnly={saving}
          value={reason}
          placeholder={t("back_office.billing.change_reason")}
          aria-label={t("back_office.billing.change_reason")}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={keys}
        />
      )}
      {message && (
        <small role="alert" className="bo-billing-error">
          {message}
        </small>
      )}
    </div>
  ) : (
    <button
      ref={anchor}
      type="button"
      className="bo-billing-cell"
      aria-label={label}
      title={value}
      onClick={() => {
        cancel.current = false;
        setMessage("");
        setReason("");
        setEdit({ initial: value, revision, value });
      }}
    >
      {value}
    </button>
  );
}
