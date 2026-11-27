import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button, Input } from "twenty-ui/primitives/input";
import { BackOfficeLinkListSchema, BackOfficeTextListSchema, type BackOfficeField, type BackOfficeValue } from "@legalwork/types/back-office";
import { t } from "@/i18n";

export function OrderedListEditor({ field, value, onSave, onCancel }: {
  field: BackOfficeField;
  value: BackOfficeValue | undefined;
  onSave: (next: BackOfficeValue) => Promise<void>;
  onCancel: () => void;
}) {
  const links = field.type === "linkList";
  const [rows, setRows] = useState(() => {
    const items = links ? BackOfficeLinkListSchema.parse(value ?? []) : BackOfficeTextListSchema.parse(value ?? []);
    return items.map(item => ({ key: crypto.randomUUID(), ...(typeof item === "string" ? { label: item, url: "" } : item) }));
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const edit = (index: number, changes: { label?: string; url?: string }) => {
    setRows(rows.map((row, i) => i === index ? { ...row, ...changes } : row));
  };
  const move = (from: number, to: number) => {
    const next = [...rows];
    [next[from], next[to]] = [next[to], next[from]];
    setRows(next);
  };
  const save = async () => {
    const result = links ? BackOfficeLinkListSchema.safeParse(rows.map(({ label, url }) => ({ label, url })))
      : BackOfficeTextListSchema.safeParse(rows.map(row => row.label));
    if (!result.success || (field.required && !rows.length)) {
      setError(t(links ? "back_office.list.invalid_link" : "back_office.list.invalid_text"));
      return;
    }
    setBusy(true);
    setError("");
    try { await onSave(result.data); onCancel(); }
    catch (error) { setError(error instanceof Error ? error.message : t("back_office.save_failed")); }
    finally { setBusy(false); }
  };
  return <div className="bo-cell-form" aria-label={t("projects.edit_value", { name: field.label })}
    onKeyDown={event => { event.stopPropagation(); if (!busy && event.key === "Escape") onCancel(); }}>
    <form noValidate onSubmit={event => { event.preventDefault(); event.stopPropagation(); if (!busy) void save(); }}>
      <div className="bo-list-rows">{rows.map((row, i) => <fieldset key={row.key} disabled={busy}>
        <legend>{t("back_office.list.item", { number: i + 1 })}</legend>
        <Input size="sm" maxLength={200} value={row.label} aria-label={t(links ? "back_office.list.label" : "back_office.list.item", { number: i + 1 })}
          placeholder={links ? t("back_office.list.label", { number: i + 1 }) : undefined} onChange={event => edit(i, { label: event.target.value })} />
        {links && <Input size="sm" type="url" maxLength={2048} value={row.url} aria-label={t("back_office.list.url", { number: i + 1 })}
          placeholder="https://…" onChange={event => edit(i, { url: event.target.value })} />}
        <div className="bo-list-actions">
          <Button type="button" variant="ghost" size="sm" aria-label={t("markdown.blocks.move_up")} disabled={!i} onClick={() => move(i, i - 1)} startIcon={<ArrowUp size={14} />} />
          <Button type="button" variant="ghost" size="sm" aria-label={t("markdown.blocks.move_down")} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)} startIcon={<ArrowDown size={14} />} />
          <Button type="button" variant="ghost" size="sm" aria-label={t("back_office.list.remove", { number: i + 1 })} onClick={() => setRows(rows.filter(item => item.key !== row.key))} startIcon={<X size={14} />} />
        </div>
      </fieldset>)}</div>
      <Button type="button" variant="ghost" size="sm" disabled={busy || rows.length >= (links ? 100 : 1000)} startIcon={<Plus size={14} />}
        onClick={() => setRows([...rows, { key: crypto.randomUUID(), label: "", url: "" }])}>{t("back_office.list.add")}</Button>
      {error && <p className="bo-error" role="alert">{error}</p>}
      <div className="bo-list-actions"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t("projects.cancel")}</Button>
        <Button type="submit" variant="solid" size="sm" disabled={busy}>{t("scheduled.save")}</Button></div>
    </form>
  </div>;
}
