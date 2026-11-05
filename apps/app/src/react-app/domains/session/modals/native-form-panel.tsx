import { useState } from "react";
import type { FormInfo, FormField } from "@opencode/client";
import { Button } from "@/components/ui/button";
import { openDesktopUrl } from "@/app/lib/desktop";
import { InteractionSource } from "../chat/interaction-source";
import { t } from "@/i18n";

export function initialFormAnswers(form: FormInfo): string[][] {
  return form.fields.map((field) =>
    "default" in field && field.default !== undefined
      ? Array.isArray(field.default)
        ? field.default
        : [String(field.default)]
      : [],
  );
}
export function fieldVisible(
  field: FormField,
  form: FormInfo,
  answers: string[][],
): boolean {
  if (field.type === "external") return true;
  if (field.hidden) return false;
  return (field.when ?? []).every((condition) => {
    const index = form.fields.findIndex((item) => item.key === condition.key);
    const dependency = form.fields[index];
    const raw = answers[index]?.[0];
    const value =
      dependency?.type === "boolean"
        ? raw === "true"
        : dependency?.type === "integer" || dependency?.type === "number"
          ? Number(raw)
          : raw;
    return condition.op === "eq"
      ? value === condition.value
      : value !== condition.value;
  });
}
/** Native fields retain their keys, values, constraints and conditional visibility. */
export function NativeFormPanel(props: {
  form: FormInfo;
  busy: boolean;
  onReply: (answers: string[][]) => void;
  submitLabel?: string;
  sourceSession?: { id: string; title: string };
  onOpenSession?: (id: string) => void;
}) {
  const [answers, setAnswers] = useState(() => initialFormAnswers(props.form));
  const set = (index: number, values: string[]) =>
    setAnswers((current) =>
      current.map((value, position) => (position === index ? values : value)),
    );
  const inputClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
  return (
    <form
      className="space-y-3 border-b border-dls-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        props.onReply(answers);
      }}
    >
      <InteractionSource
        session={props.sourceSession}
        onOpenSession={props.onOpenSession}
      />
      <div className="text-sm font-medium">{props.form.title}</div>
      {props.form.fields.map((field, index) => {
        if (!fieldVisible(field, props.form, answers)) return null;
        const value = answers[index] ?? [];
        if (field.type === "external")
          return (
            <div key={field.key} className="space-y-2">
              <p className="text-sm">{field.description}</p>
              <Button
                type="button"
                disabled={props.busy}
                onClick={() => void openDesktopUrl(field.url)}
              >
                {field.title ?? field.url}
              </Button>
            </div>
          );
        return (
          <label key={field.key} className="block space-y-1.5 text-sm">
            <span>{field.title ?? field.key}</span>
            {field.description ? (
              <p className="text-xs text-muted-foreground">
                {field.description}
              </p>
            ) : null}
            {field.type === "boolean" ? (
              <input
                type="checkbox"
                checked={value[0] === "true"}
                disabled={props.busy}
                onChange={(event) =>
                  set(index, [String(event.currentTarget.checked)])
                }
              />
            ) : field.type === "multiselect" ? (
              <div className="space-y-1.5">
                {field.options.map((option) => (
                  <label key={option.value} className="flex gap-2">
                    <input
                      type="checkbox"
                      checked={value.includes(option.value)}
                      disabled={props.busy}
                      onChange={(event) =>
                        set(
                          index,
                          event.currentTarget.checked
                            ? [...value, option.value]
                            : value.filter((item) => item !== option.value),
                        )
                      }
                    />
                    <span>
                      {option.label}
                      {option.description ? ` — ${option.description}` : ""}
                    </span>
                  </label>
                ))}
                {field.custom ? (
                  <input
                    className={inputClass}
                    placeholder={t("question_modal.custom_answer_placeholder")}
                    disabled={props.busy}
                    onBlur={(event) => {
                      const custom = event.currentTarget.value;
                      if (custom && !value.includes(custom))
                        set(index, [...value, custom]);
                    }}
                  />
                ) : null}
              </div>
            ) : field.type === "string" && field.options && !field.custom ? (
              <select
                className={inputClass}
                value={value[0] ?? ""}
                required={field.required}
                disabled={props.busy}
                onChange={(event) => set(index, [event.currentTarget.value])}
              >
                <option value="">{t("common.select")}</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === "string" ? (
              <>
                <input
                  className={inputClass}
                  type={
                    field.format === "uri"
                      ? "url"
                      : field.format === "date-time"
                        ? "datetime-local"
                        : (field.format ?? "text")
                  }
                  value={value[0] ?? ""}
                  required={field.required}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  pattern={field.pattern}
                  placeholder={field.placeholder}
                  disabled={props.busy}
                  list={
                    field.options ? `${props.form.id}:${field.key}` : undefined
                  }
                  onChange={(event) => set(index, [event.currentTarget.value])}
                />
                {field.options ? (
                  <datalist id={`${props.form.id}:${field.key}`}>
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </datalist>
                ) : null}
              </>
            ) : (
              <input
                className={inputClass}
                type="number"
                step={field.type === "integer" ? 1 : "any"}
                value={value[0] ?? ""}
                required={field.required}
                min={field.minimum}
                max={field.maximum}
                disabled={props.busy}
                onChange={(event) => set(index, [event.currentTarget.value])}
              />
            )}
          </label>
        );
      })}
      {props.submitLabel || props.form.fields.some((field) => field.type !== "external") ? (
        <Button type="submit" disabled={props.busy}>
          {props.submitLabel ?? t("common.submit")}
        </Button>
      ) : null}
    </form>
  );
}
