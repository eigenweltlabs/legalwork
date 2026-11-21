import { useState } from "react";
import { Button } from "twenty-ui/primitives/input";
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
  onChange: (values: Record<string, string> | undefined) => void;
}) {
  const [term, setTerm] = useState("");
  const [replacement, setReplacement] = useState("");
  function update(key: string, text: string) {
    const next = { ...values };
    if (text) next[key] = text;
    else delete next[key];
    onChange(Object.keys(next).length ? next : undefined);
  }
  return (
    <details>
      <summary>{label}</summary>
      {Object.entries({ ...inherited, ...values }).map(([key, value]) => (
        <label key={key} className="bo-billing-rule">
          <span>{key}</span>
          <input
            aria-label={key}
            placeholder={inherited[key]}
            value={values?.[key] ?? ""}
            onChange={(e) => update(key, e.target.value)}
            title={value}
          />
        </label>
      ))}
      <div className="bo-billing-subrow">
        <input
          aria-label={fromLabel}
          placeholder={fromLabel}
          value={term}
          maxLength={200}
          onChange={(e) => setTerm(e.target.value)}
        />
        <input
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
            update(term.trim(), replacement.trim());
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
