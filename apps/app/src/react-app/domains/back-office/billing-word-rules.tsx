import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";

export function BillingWordRules({
  label,
  fromLabel,
  toLabel,
  values,
  inherited,
  onChange,
}: {
  label: string;
  fromLabel: string;
  toLabel: string;
  values?: Record<string, string>;
  inherited: Record<string, string>;
  onChange: (values: Record<string, string> | undefined, persist: boolean) => void;
}) {
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  function update(key: string, text: string, persist = false) {
    const next = { ...values };
    if (text) next[key] = text;
    else delete next[key];
    onChange(Object.keys(next).length ? next : undefined, persist);
  }
  return (
    <details>
      <summary>{label}</summary>
      {Object.entries({ ...inherited, ...values }).map(([key, value]) => (
        <label key={key} className="bo-billing-rule">
          <span>{key}</span>
          <Input
            aria-label={key}
            placeholder={inherited[key]}
            value={values?.[key] ?? ""}
            onChange={(e) => update(key, e.target.value)}
            title={value}
          />
        </label>
      ))}
      <div className="bo-billing-subrow">
        <Input
          aria-label={fromLabel}
          placeholder={fromLabel}
          value={term}
          maxLength={200}
          onChange={(e) => setTerm(e.target.value)}
        />
        <Input
          aria-label={toLabel}
          placeholder={toLabel}
          value={replacement}
          maxLength={80}
          onChange={(e) => setReplacement(e.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!term.trim() || !replacement.trim()}
          onClick={() => {
            update(term.trim(), replacement.trim(), true);
            setTerm("");
            setReplacement("");
          }}
        >
          {t("back_office.billing.add_word_rule")}
        </Button>
      </div>
    </details>
  );
}
