import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, ArrowRight, HelpCircle, Pencil, X } from "lucide-react";
import type { FormInfo, FormField } from "@opencode/client";
import { browserPasswordRequest } from "@legalwork/types/browser-password-request";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { BrowserPasswordForm } from "./browser-password-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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

function stringInputType(format: Extract<FormField, { type: "string" }>["format"]) {
  if (format === "uri") return "url";
  if (format === "date-time") return "datetime-local";
  return format ?? "text";
}

function FormChoices(props: {
  field: Extract<FormField, { type: "string" | "multiselect" }>;
  value: string[];
  disabled: boolean;
  labelledBy: string;
  onChange: (value: string[]) => void;
  onConfirm: (option: string) => void;
}) {
  const id = useId();
  const { field, value } = props;
  const options = field.options ?? [];
  const multiple = field.type === "multiselect";
  const choices = options.map((option, index) => (
    <label key={option.value} className="group/choice flex min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border border-transparent px-2 py-2 transition-colors duration-[var(--lw-duration-fast)] hover:bg-muted/60 has-data-checked:border-primary/30 has-data-checked:bg-muted/60 has-focus-visible:ring-2 has-focus-visible:ring-ring/30"
      onDoubleClick={(event) => {
        event.preventDefault();
        if (!props.disabled) props.onConfirm(option.value);
      }}>
      <span className="sr-only">{multiple ? (
        <Checkbox
          checked={value.includes(option.value)}
          disabled={props.disabled}
          aria-labelledby={`${id}-${index}-label`}
          aria-describedby={option.description ? `${id}-${index}` : undefined}
          onCheckedChange={(checked) => props.onChange(checked ? [...value, option.value] : value.filter((item) => item !== option.value))}
        />
      ) : (
        <RadioGroupItem value={option.value} aria-labelledby={`${id}-${index}-label`} aria-describedby={option.description ? `${id}-${index}` : undefined} />
      )}</span>
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60 text-xs text-muted-foreground">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 break-words">
        <span id={`${id}-${index}-label`} className="block text-sm leading-6 text-foreground">{option.label}</span>
        {option.description ? <span id={`${id}-${index}`} className="mt-0.5 block whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{option.description}</span> : null}
      </span>
      {!multiple ? <ArrowRight aria-hidden="true" size={16} className="mt-1 shrink-0 text-muted-foreground opacity-0 group-hover/choice:opacity-100 group-has-data-checked/choice:opacity-100 group-has-focus-visible/choice:opacity-100" /> : null}
    </label>
  ));
  return (
    <>
      {multiple ? <div className="grid gap-0.5">{choices}</div> : (
        <RadioGroup
          className="relative gap-0.5"
          aria-labelledby={props.labelledBy}
          aria-required={field.required}
          disabled={props.disabled}
          value={value[0] ?? null}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            props.onChange([next]);
          }}
        >{choices}</RadioGroup>
      )}
    </>
  );
}

/** Native fields retain their keys, values, constraints and conditional visibility. */
export function NativeFormPanel(props: {
  form: FormInfo;
  client?: LegalworkServerClient;
  busy: boolean;
  onReply: (answers: string[][]) => void;
  onCancel?: () => void;
  submitLabel?: string;
  sourceSession?: { id: string; title: string };
  onOpenSession?: (id: string) => void;
}) {
  const [answers, setAnswers] = useState(() => initialFormAnswers(props.form));
  const [customInputs, setCustomInputs] = useState(() => props.form.fields.map((field, index) =>
    field.type === "string" || field.type === "multiselect"
      ? answers[index].filter((value) => !field.options?.some((option) => option.value === value)).join(", ")
      : "",
  ));
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const completedSteps = useRef(new Set<string>());
  const [stepKey, setStepKey] = useState<string | null>(null);
  const isQuestion = props.form.metadata?.kind === "question";
  const visibleFields = props.form.fields.flatMap((field, index) => fieldVisible(field, props.form, answers) ? [{ field, index }] : []);
  const stepIndex = Math.max(0, visibleFields.findIndex(({ field }) => field.key === stepKey));
  const currentStep = isQuestion ? visibleFields[stepIndex] : undefined;
  const displayedFields = currentStep ? [currentStep] : visibleFields;
  const multipleSteps = isQuestion && visibleFields.length > 1;
  const lastStep = !isQuestion || stepIndex >= visibleFields.length - 1;
  useEffect(() => {
    if (stepKey === null) return;
    contentRef.current?.scrollTo({ top: 0 });
    contentRef.current?.querySelector("fieldset")?.focus();
  }, [stepKey]);
  const set = (index: number, values: string[]) => {
    completedSteps.current.delete(props.form.fields[index].key);
    setAnswers((current) =>
      current.map((value, position) => (position === index ? values : value)),
    );
  };
  const choicesComplete = displayedFields.every(({ field, index }) => {
    const value = answers[index] ?? [];
    if (field.type === "multiselect") {
      return value.length >= Math.max(field.required ? 1 : 0, field.minItems ?? 0)
        && (field.maxItems === undefined || value.length <= field.maxItems);
    }
    return field.type !== "string" || !field.options?.length || !field.required || Boolean(value[0]?.trim());
  });
  const onlyField = displayedFields.length === 1 ? displayedFields[0] : undefined;
  const footerField = onlyField && (onlyField.field.type === "multiselect" || (onlyField.field.type === "string" && onlyField.field.options?.length)) && onlyField.field.custom ? onlyField : null;
  const setCustomInput = (index: number, value: string) => setCustomInputs((current) => current.map((input, position) => position === index ? value : input));
  const confirmChoice = (index: number, option: string) => {
    if (props.busy) return;
    const field = props.form.fields[index];
    if (field.type !== "string" && field.type !== "multiselect") return;
    completedSteps.current.delete(field.key);
    // Commit the clicked choice before native validation and conditional fields run.
    flushSync(() => {
      if (field.type === "string") setCustomInput(index, "");
      setAnswers((current) => current.map((value, position) => position !== index ? value
        : field.type === "multiselect" ? value.includes(option) ? value : [...value, option]
        : [option]));
    });
    formRef.current?.requestSubmit();
  };
  const renderCustomInput = (field: FormField, index: number) => {
    if (field.type !== "string" && field.type !== "multiselect") return null;
    return (
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Pencil aria-hidden="true" size={16} className="shrink-0 text-muted-foreground" />
        <Input
          aria-label={t("question_modal.custom_answer_label")}
          type={field.type === "string" ? stringInputType(field.format) : "text"}
          value={customInputs[index]}
          placeholder={t("question_modal.custom_answer_label")}
          minLength={field.type === "string" ? field.minLength : undefined}
          maxLength={field.type === "string" ? field.maxLength : undefined}
          pattern={field.type === "string" ? field.pattern : undefined}
          disabled={props.busy}
          className="h-8 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          onChange={(event) => {
            const next = event.currentTarget.value;
            setCustomInput(index, next);
            const selected = field.type === "multiselect" ? answers[index].filter((value) => field.options.some((option) => option.value === value)) : [];
            set(index, next.trim() ? [...selected, next] : selected);
          }}
        />
      </div>
    );
  };
  const passwordRequest = browserPasswordRequest(props.form.metadata);
  if (passwordRequest) return <div className="w-full">
    <InteractionSource session={props.sourceSession} onOpenSession={props.onOpenSession} />
    <BrowserPasswordForm request={passwordRequest} client={props.client} busy={props.busy}
      onComplete={id => props.onReply(props.form.fields.map(field => [field.key === "password_id" ? id : field.key === "cancelled" ? "false" : ""]))}
      onCancel={() => props.onReply(props.form.fields.map(field => [field.key === "cancelled" ? "true" : ""]))} />
  </div>;
  return (
    <form
      ref={formRef}
      className={`min-w-0 border-b border-dls-border text-foreground ${isQuestion ? "flex max-h-[50dvh] flex-col" : ""}`}
      aria-label={props.form.title}
      aria-busy={props.busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (props.busy || !choicesComplete) return;
        if (currentStep && !lastStep) {
          completedSteps.current.add(currentStep.field.key);
          setStepKey(visibleFields[stepIndex + 1].field.key);
          return;
        }
        // A later answer can reveal an earlier conditional question. Visit it
        // before sending so every visible step receives native validation.
        if (isQuestion) {
          const unfinished = visibleFields.find(({ field }) => field.key !== currentStep?.field.key && !completedSteps.current.has(field.key));
          if (unfinished) {
            setStepKey(unfinished.field.key);
            return;
          }
        }
        props.onReply(answers);
      }}
    >
      <InteractionSource
        session={props.sourceSession}
        onOpenSession={props.onOpenSession}
      />
      <div className="flex shrink-0 items-center gap-2 px-4 pb-4 pt-3 text-sm text-muted-foreground">
        <HelpCircle aria-hidden="true" size={16} />
        {props.form.title === "Questions" || props.form.title === "Question" ? t("common.question") : props.form.title}
        {multipleSteps ? <span className="ml-auto text-xs tabular-nums" aria-live="polite" aria-atomic="true"
          aria-label={t("question_modal.question_counter", undefined, { current: stepIndex + 1, total: visibleFields.length })}>
          {stepIndex + 1} / {visibleFields.length}
        </span> : null}
        {props.onCancel ? (
          <Button type="button" variant="ghost" size="icon-xs" className={multipleSteps ? undefined : "ml-auto"} aria-label={t("common.close")} disabled={props.busy} onClick={props.onCancel}>
            <X size={14} />
          </Button>
        ) : null}
      </div>
      <div ref={contentRef} className="min-h-0 max-h-[min(24rem,45dvh)] space-y-5 overflow-y-auto px-2 pb-2">
        {displayedFields.map(({ field, index }) => {
          const value = answers[index] ?? [];
          const choice = field.type === "multiselect" || (field.type === "string" && Boolean(field.options?.length));
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
            <fieldset key={field.key} tabIndex={isQuestion ? -1 : undefined} disabled={props.busy} className="min-w-0 space-y-2 border-0 p-0 text-sm outline-none disabled:opacity-60" aria-describedby={!choice && field.description ? `${id}-${index}-description` : undefined}>
              <legend id={`${id}-${index}-title`} className="mb-2 whitespace-pre-wrap px-2 text-sm font-medium leading-6">{choice ? field.description || field.title || field.key : field.title ?? field.key}</legend>
              {!choice && field.description ? (
                <p id={`${id}-${index}-description`} className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {field.description}
                </p>
              ) : null}
              {field.type === "boolean" ? (
                <Checkbox
                  aria-labelledby={`${id}-${index}-title`}
                  checked={value[0] === "true"}
                  disabled={props.busy}
                  onCheckedChange={(checked) =>
                    set(index, [String(checked)])
                  }
                />
              ) : field.type === "multiselect" || (field.type === "string" && Boolean(field.options?.length)) ? (
                <FormChoices
                  field={field}
                  value={value}
                  disabled={props.busy}
                  labelledBy={`${id}-${index}-title`}
                  onConfirm={(option) => confirmChoice(index, option)}
                  onChange={(values) => {
                    if (field.type === "string") setCustomInput(index, "");
                    set(index, values);
                  }}
                />
              ) : field.type === "string" ? (
                  <Input
                    aria-labelledby={`${id}-${index}-title`}
                    type={stringInputType(field.format)}
                    value={value[0] ?? ""}
                    required={field.required}
                    minLength={field.minLength}
                    maxLength={field.maxLength}
                    pattern={field.pattern}
                    placeholder={field.placeholder}
                    disabled={props.busy}
                    onChange={(event) => set(index, [event.currentTarget.value])}
                  />
              ) : (
                <Input
                  aria-labelledby={`${id}-${index}-title`}
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
              {choice && field.custom && footerField?.index !== index ? <div className="px-2 pt-2">{renderCustomInput(field, index)}</div> : null}
            </fieldset>
          );
        })}
      </div>
      {props.submitLabel || props.form.fields.some((field) => field.type !== "external") ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 px-4 pb-3 pt-2">
          {footerField ? <div className={multipleSteps ? "min-w-0 basis-full" : "min-w-0 flex-1"}>{renderCustomInput(footerField.field, footerField.index)}</div> : null}
          {multipleSteps ? <Button type="button" variant="ghost" size="sm" className="mr-auto" disabled={props.busy || stepIndex === 0}
            onClick={() => setStepKey(visibleFields[stepIndex - 1].field.key)}>
            <ArrowLeft data-icon="inline-start" />{t("common.back")}
          </Button> : null}
          {props.onCancel ? <Button type="button" variant="outline" size="sm" disabled={props.busy} onClick={props.onCancel}>{t("common.skip")}</Button> : null}
          <Button type="submit" size="sm" disabled={props.busy || !choicesComplete}>
            {props.submitLabel ?? (lastStep ? t("question_modal.custom_answer_send") : t("common.next"))}
            {!lastStep ? <ArrowRight data-icon="inline-end" /> : null}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
