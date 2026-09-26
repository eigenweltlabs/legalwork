import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";

const normalized = (value: string) => value.trim().normalize("NFKC").toLocaleLowerCase();
export function validReviewOptions(options: string[]) {
  const values = options.map(normalized);
  return values.length >= 2 && values.length <= 30 && values.every(Boolean) && new Set(values).size === values.length;
}

/** Stable row identity keeps editing/focus intact when another option is removed. */
export function ReviewOptions({ value, onChange, disabled }: { value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const [rows, setRows] = useState(() => value.map(text => ({ id: crypto.randomUUID(), text, touched: false })));
  const [focus, setFocus] = useState<string | null>(null);
  const update = (next: typeof rows) => { setRows(next); onChange(next.map(row => row.text)); };
  const add = () => {
    if (disabled || rows.length >= 30) return;
    const id = crypto.randomUUID(); setFocus(id); update([...rows, { id, text: "", touched: false }]);
  };
  return <fieldset disabled={disabled} className="min-w-0 space-y-2">
    <legend className="mb-2 text-sm font-medium">{t("review.options")}</legend>
    <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
      {rows.map((row, index) => {
        const duplicate = !!normalized(row.text) && rows.some(other => other.id !== row.id && normalized(other.text) === normalized(row.text));
        const error = duplicate ? t("review.option_duplicate") : row.touched && !row.text.trim() ? t("review.option_empty") : null;
        return <div key={row.id} className="space-y-1">
          <div className="flex items-center gap-2">
            <span aria-hidden className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
            <Input value={row.text} autoFocus={focus === row.id} maxLength={300} aria-label={t("review.option_number", { number: index + 1 })} aria-invalid={!!error} aria-describedby={error ? `${row.id}-error` : undefined}
              placeholder={t("review.option_placeholder")} className="h-9 min-w-0 flex-1" onBlur={() => setRows(current => current.map(item => item.id === row.id ? { ...item, touched: true } : item))}
              onChange={event => update(rows.map(item => item.id === row.id ? { ...item, text: event.target.value } : item))}
              onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); if (row.text.trim() && !duplicate) add(); } }} />
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("review.remove_option", { number: index + 1 })} onClick={() => update(rows.filter(item => item.id !== row.id))}><X className="size-3.5" /></Button>
          </div>
          {error && <p id={`${row.id}-error`} role="alert" className="pl-7 text-xs text-destructive">{error}</p>}
        </div>;
      })}
    </div>
    <div className="flex items-center justify-between gap-3 pl-7">
      <Button type="button" variant="ghost" size="sm" className="-ml-2 h-8" disabled={disabled || rows.length >= 30} onClick={add}><Plus className="size-3.5" />{t("review.add_option")}</Button>
      <span className="text-xs tabular-nums text-muted-foreground">{rows.length} / 30</span>
    </div>
    <p className="pl-7 text-xs text-muted-foreground">{t("review.options_hint")}</p>
  </fieldset>;
}
