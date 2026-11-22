import { useEffect, useRef, useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TimeSelect } from "./time-settings-controls";
import { Button } from "@/components/ui/button";
import { t, currentLocale } from "@/i18n";
import { ChevronRight, FileText, Link2, Plus, Upload } from "lucide-react";
import { Link } from "react-router-dom";
import { Surface } from "../../design-system/surface";
import {
  workdayGuidelineSchema,
  guidelineRuleSuggestionsSchema,
  guidelineRuleFields,
  type GuidelineRuleSuggestions,
  type CaptureAction,
  type CaptureState,
} from "@legalwork/types/time-capture";
import type { TimesheetState } from "@legalwork/types/timesheet";
import { roundingKeys } from "./timesheet-labels";
import "./time-workspace-guidelines.css";

type Guideline = CaptureState["guidelines"][number];
type Actions = Extract<CaptureAction, { type: "guideline" }>;
type Scope = Guideline["scope"];
const scopeKeys = {
  firm: "back_office.billing.scope_firm",
  client: "back_office.billing.scope_client",
  matter: "back_office.billing.scope_matter",
};

const maximumFileBytes = 8 * 1024 * 1024;
const maximumInstructions = 20_000;

async function docxGuidelineText(file: File) {
  const [{ default: JSZip }, { elements, parseXml }] = await Promise.all([
    import("jszip"),
    import("../session/artifacts/docx-word-package"),
  ]);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const main = zip.file("word/document.xml");
  if (
    !main ||
    !("internalStream" in main) ||
    typeof main.internalStream !== "function"
  )
    throw new Error("Missing document");
  const stream: import("jszip").JSZipStreamHelper<string> =
    main.internalStream("string");
  const text = await new Promise<string>((resolve, reject) => {
    const parts: string[] = [];
    let size = 0;
    stream
      .on("data", (chunk) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          stream.pause();
          reject(new Error("Document text is too large"));
          return;
        }
        parts.push(chunk);
      })
      .on("error", reject)
      .on("end", () => resolve(parts.join("")))
      .resume();
  });
  const xml = parseXml(text);
  if (!xml.documentElement || xml.getElementsByTagName("parsererror").length)
    throw new Error("Invalid document");
  return elements(xml, "p")
    .map((paragraph) =>
      elements(paragraph, "t")
        .map((run) => run.textContent ?? "")
        .join("")
        .trim(),
    )
    .filter(Boolean)
    .join("\n\n");
}

export function TimeWorkspaceGuidelines({
  date,
  initialTarget,
  guidelines,
  state,
  pending,
  save,
  readPdf,
  extractRules,
}: {
  date: string;
  initialTarget?: { scope: "client" | "matter"; targetId: string };
  guidelines: CaptureState["guidelines"];
  state: TimesheetState;
  pending: boolean;
  save: (action: Actions) => Promise<boolean>;
  extractRules?: (text: string, signal: AbortSignal) => Promise<GuidelineRuleSuggestions>;
  readPdf: (
    file: File,
    signal: AbortSignal,
  ) => Promise<{ text: string; textlessPages: number[] }>;
}) {
  const filePicker = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<Guideline>();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>(initialTarget?.scope ?? "firm");
  const [target, setTarget] = useState(initialTarget?.targetId ?? "");
  const scopedGuidelines = initialTarget
    ? guidelines.filter(item => item.scope === initialTarget.scope && item.targetId === initialTarget.targetId)
    : guidelines;
  const [formOpen, setFormOpen] = useState(Boolean(initialTarget && scopedGuidelines.length === 0));
  const [effective, setEffective] = useState(date);
  const [rules, setRules] = useState("{\n}");
  const [instructions, setInstructions] = useState("");
  const [structured, showStructured] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [loadingRules, setLoadingRules] = useState(false);
  const [suggestions, setSuggestions] = useState<GuidelineRuleSuggestions>();
  const [sourceWarning, setSourceWarning] = useState("");
  const [error, setError] = useState("");
  const newId = useRef<string | undefined>(undefined);
  const extraction = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => extraction.current?.abort(), []);
  const busy = pending || loadingFile || loadingRules;
  function parsedRules() {
    try { return workdayGuidelineSchema.shape.rules.safeParse(JSON.parse(rules)).data; }
    catch { return undefined; }
  }
  const currentRules = parsedRules();
  function updateRule(field: typeof guidelineRuleFields[number], value: number | boolean | string | undefined) {
    if (!currentRules) { showStructured(true); setError(t("timeWorkspace.guidelineInvalid", { field: t("timeWorkspace.guidelineRules") })); return; }
    const next = workdayGuidelineSchema.shape.rules.safeParse({ ...currentRules, [field]: value });
    if (!next.success) { setError(t("timeWorkspace.guidelineInvalid", { field: t("timeWorkspace." + field) })); return; }
    setRules(JSON.stringify(next.data, null, 2));
    setError("");
    setSuggestions(undefined);
  }
  async function inferRules(text: string, controller: AbortController) {
    if (!extractRules || !text.trim() || text.length > maximumInstructions) return;
    const retained = parsedRules();
    if (!retained) { showStructured(true); setError(t("timeWorkspace.guidelineInvalid", { field: t("timeWorkspace.guidelineRules") })); return; }
    setLoadingRules(true);
    try {
      const next = guidelineRuleSuggestionsSchema.parse(await extractRules(text, controller.signal));
      if (controller.signal.aborted) return;
      setSuggestions(next);
      setRules(JSON.stringify({ ...retained, ...next.rules }, null, 2));
    } catch (error) {
      if (!controller.signal.aborted) setError(t("timeWorkspace.guidelineExtractError") + " " + (error instanceof Error ? error.message : ""));
    } finally {
      if (extraction.current === controller) setLoadingRules(false);
    }
  }
  const latest = new Map<string, Guideline>();
  for (const guideline of scopedGuidelines) {
    if ((latest.get(guideline.id)?.revision ?? -1) < guideline.revision)
      latest.set(guideline.id, guideline);
  }
  function load(guideline?: Guideline) {
    setEditing(guideline);
    setName(guideline?.name ?? "");
    setScope(guideline?.scope ?? initialTarget?.scope ?? "firm");
    setTarget(guideline?.targetId ?? initialTarget?.targetId ?? "");
    setEffective(guideline?.effectiveFrom ?? date);
    const { instructions, ...structuredRules } = guideline?.rules ?? {};
    setInstructions(instructions ?? "");
    setRules(guideline ? JSON.stringify(structuredRules, null, 2) : "{\n}");
    setSourceWarning("");
    setError("");
    setSuggestions(undefined);
    newId.current = undefined;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    newId.current ??= crypto.randomUUID();
    try {
      const parsedRules = workdayGuidelineSchema.shape.rules.safeParse(
        JSON.parse(rules),
      );
      if (!parsedRules.success) {
        setError(
          t("timeWorkspace.guidelineInvalid", {
            field: t("timeWorkspace.guidelineRules"),
          }),
        );
        showStructured(true);
        return;
      }
      const parsed = workdayGuidelineSchema.safeParse({
        id: editing?.id ?? newId.current,
        revision: editing?.revision ?? 0,
        name,
        scope,
        targetId: scope === "firm" ? "firm" : target,
        effectiveFrom: effective,
        rules: {
          ...parsedRules.data,
          instructions:
            instructions.trim() || parsedRules.data.instructions || undefined,
        },
      });
      if (!parsed.success) {
        setError(
          t("timeWorkspace.guidelineInvalid", {
            field:
              parsed.error.issues[0]?.path.join(".") ||
              t("timeWorkspace.guidelineRules"),
          }),
        );
        return;
      }
      if (await save({ type: "guideline", guideline: parsed.data })) {
        load();
        setFormOpen(false);
      }
    } catch {
      setError(
        t("timeWorkspace.guidelineInvalid", {
          field: t("timeWorkspace.guidelineRules"),
        }),
      );
    }
  }
  async function preview(file: File) {
    if (busy) return;
    extraction.current?.abort();
    const controller = new AbortController();
    extraction.current = controller;
    setError("");
    setSourceWarning("");
    setSuggestions(undefined);
    if (file.size > maximumFileBytes) {
      setError(t("timeWorkspace.guidelineSize"));
      return;
    }
    const extension = file.name.toLowerCase().split(".").at(-1);
    setLoadingFile(true);
    try {
      if (extension === "json") {
        const structured = workdayGuidelineSchema.shape.rules.parse(
          JSON.parse(await file.text()),
        );
        if (controller.signal.aborted) return;
        const { instructions, ...json } = structured;
        setInstructions(instructions ?? "");
        setRules(JSON.stringify(json, null, 2));
        showStructured(true);
      } else {
        const result =
          extension === "pdf"
            ? await readPdf(file, controller.signal)
            : undefined;
        const text =
          result?.text ??
          (extension === "txt"
            ? await file.text()
            : extension === "docx"
              ? await docxGuidelineText(file)
              : "");
        if (controller.signal.aborted) return;
        if (!text.trim()) {
          setError(
            t(
              extension === "pdf"
                ? "timeWorkspace.guidelineScan"
                : "timeWorkspace.guidelineUnreadable",
            ),
          );
          return;
        }
        setInstructions(text.trim());
        await inferRules(text.trim(), controller);
        if (result?.textlessPages.length)
          setSourceWarning(
            t("timeWorkspace.guidelineSkippedPages", {
              pages: result.textlessPages.join(", "),
            }),
          );
      }
      if (!name)
        setName(file.name.replace(/\.(json|txt|docx|pdf)$/i, "").slice(0, 240));
    } catch {
      if (!controller.signal.aborted)
        setError(t("timeWorkspace.guidelineUnreadable"));
    } finally {
      if (!controller.signal.aborted) setLoadingFile(false);
      if (extraction.current === controller) extraction.current = undefined;
    }
  }
  const targetName = (scope: Scope, id: string) => scope === "firm" ? t(scopeKeys.firm)
    : (scope === "client" ? state.clients : state.matters).find(item => item.id === id)?.name ?? t(scopeKeys[scope]);
  const fixedTarget = Boolean(editing || initialTarget);
  return (
    <section className="time-workspace-guidelines grid gap-3" aria-labelledby="billing-guidelines-title">
      <div className="flex items-center justify-between gap-3">
        <h3 id="billing-guidelines-title" className="text-[13px] font-semibold">{t("timeWorkspace.guidelines")}</h3>
        {!formOpen && <Button variant="outline" size="sm" disabled={busy} onClick={() => { load(); setFormOpen(true); }}>
          <Plus />{t("timeWorkspace.guidelineNew")}
        </Button>}
      </div>
      <p className="text-sm text-muted-foreground">{t("timeWorkspace.guidelineHint")}</p>
      {!formOpen && <Surface className="divide-y divide-border/70 overflow-hidden">
        {latest.size === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">{t("timeWorkspace.guidelinesEmpty")}</p>}
        {Array.from(latest.values()).sort((a, b) => a.name.localeCompare(b.name)).map(item => (
          <button key={item.id} type="button" className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-muted/40"
            disabled={busy} onClick={() => { load(item); setFormOpen(true); }}>
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="grid min-w-0 flex-1 gap-1">
              <span className="font-medium">{item.name}</span>
              <span className="text-xs text-muted-foreground">{item.scope === "firm" ? t(scopeKeys.firm) :
                t(scopeKeys[item.scope]) + " · " + targetName(item.scope, item.targetId)}</span>
            </span>
            <span className="text-right text-xs text-muted-foreground">
              {new Date(item.effectiveFrom + "T12:00:00").toLocaleDateString(currentLocale())} · v{item.revision}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </Surface>}
      {formOpen && <Surface><form className="time-guideline-form" onSubmit={(event) => void submit(event)}>
        <div className="time-guideline-identity">
          <label>
            {t("timeWorkspace.guidelineName")}
            <Input
              value={name}
              required
              maxLength={240}
              disabled={busy}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          {fixedTarget ? (
            <div className="time-guideline-target">
              <span>{t("timeWorkspace.guidelineScope")}</span>
              {scope === "firm" ? <strong>{t(scopeKeys.firm)}</strong> : <Link className="inline-flex items-center gap-1.5 text-sm underline underline-offset-2" to={`/back-office/${scope === "matter" ? "matters" : "clients"}?record=${encodeURIComponent(target)}`}>
                <Link2 size={13} />{t(scopeKeys[scope])} · {targetName(scope, target)}
              </Link>}
            </div>
          ) : <>
            <label>
              {t("timeWorkspace.guidelineScope")}
              <TimeSelect label={t("timeWorkspace.guidelineScope")} value={scope} disabled={busy}
                options={Object.entries(scopeKeys).map(([id, key]) => ({ id, name: t(key) }))}
                onChange={next => {
                  if (next === "firm" || next === "client" || next === "matter") { setScope(next); setTarget(""); }
                }} />
            </label>
            {scope !== "firm" && (
              <label>
                {t(scopeKeys[scope])}
                <TimeSelect label={t(scopeKeys[scope])} value={target} disabled={busy}
                  placeholder={t(scope === "client" ? "timesheets.sheet.choose_bill_to" : "timesheets.workday.choose")}
                  options={scope === "client" ? state.clients : state.matters} onChange={setTarget} />
              </label>
            )}
          </>}
          <label>
            {t("timeWorkspace.guidelineEffective")}
            <Input
              type="date"
              value={effective}
              required
              disabled={busy}
              onChange={(event) => setEffective(event.currentTarget.value)}
            />
          </label>
        </div>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="time-guideline-instructions">{t("timeWorkspace.guidelineText")}</label>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => filePicker.current?.click()}>
            <Upload />{t("timeWorkspace.guidelineImport")}
          </Button>
          <input ref={filePicker} type="file" hidden aria-label={t("timeWorkspace.guidelineFile")}
            accept=".txt,.docx,.pdf,.json" disabled={busy} onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void preview(file);
            }} />
        </div>
        {loadingFile && (
          <p role="status">{t("timeWorkspace.guidelineReading")}</p>
        )}
        {loadingRules && <p role="status">{t("timeWorkspace.guidelineExtracting")}</p>}
        {sourceWarning && <p role="status">{sourceWarning}</p>}
        <Textarea id="time-guideline-instructions" rows={5} value={instructions} disabled={busy}
          onChange={(event) => { setInstructions(event.currentTarget.value); setSuggestions(undefined); }} />
        {instructions.length > maximumInstructions && (
          <p role="alert">{t("timeWorkspace.guidelineTextSize")}</p>
        )}
        {extractRules && <Button type="button" size="sm" variant="outline" disabled={busy || !instructions.trim() || instructions.length > maximumInstructions}
          onClick={() => {
            extraction.current?.abort();
            const controller = new AbortController(); extraction.current = controller;
            setError(""); void inferRules(instructions, controller);
          }}>{t("timeWorkspace.guidelineExtract")}</Button>}
        <details className="time-guideline-rules" key={suggestions ? "extracted" : "manual"} open={suggestions ? true : undefined}>
          <summary>{t("timeWorkspace.guidelineTimeRules")}</summary>
          <fieldset disabled={busy} aria-label={t("timeWorkspace.guidelineTimeRules")}>
            {(["minimumMinutes", "maxMinutes", "incrementMinutes"] as const).map(field => <label key={field}>
              {t("timeWorkspace." + field)}
              <Input type="number" min="1" max="1440" value={currentRules?.[field] ?? ""}
                onChange={event => updateRule(field, event.currentTarget.value ? Number(event.currentTarget.value) : undefined)} />
            </label>)}
            <label>{t("back_office.billing.rounding")}
              <TimeSelect label={t("back_office.billing.rounding")} value={currentRules?.rounding ?? ""} disabled={busy}
                options={[{ id: "", name: t("timeWorkspace.guidelineInherited") },
                  ...(["choose", "up", "down", "nearest"] as const).map(id => ({ id, name: t(roundingKeys[id]) }))]}
                onChange={value => updateRule("rounding", value || undefined)} />
            </label>
            <label>{t("timeWorkspace.guidelineEnforceIncrement")}
              <TimeSelect label={t("timeWorkspace.guidelineEnforceIncrement")}
                value={currentRules?.enforceIncrement === undefined ? "" : String(currentRules.enforceIncrement)} disabled={busy}
                options={[{ id: "", name: t("timeWorkspace.guidelineInherited") }, { id: "true", name: t("timeWorkspace.guidelineYes") },
                  { id: "false", name: t("timeWorkspace.guidelineNo") }]}
                onChange={value => updateRule("enforceIncrement", value === "" ? undefined : value === "true")} />
            </label>
          </fieldset>
        </details>
        {suggestions && <div className="text-xs text-muted-foreground">
          <p>{t("timeWorkspace.guidelineReviewRules")}</p>
          {Object.entries(suggestions.evidence).map(([field, quote]) => <p key={field}><strong>{t("timeWorkspace." + field)}</strong>: {quote}</p>)}
          {suggestions.notes.map((note, index) => <p key={index}>{note}</p>)}
        </div>}
        <details
          open={structured}
          onToggle={(event) => showStructured(event.currentTarget.open)}
        >
          <summary>{t("timeWorkspace.guidelineRules")}</summary>
          <Textarea
            aria-label={t("timeWorkspace.guidelineRules")}
            rows={5}
            value={rules}
            disabled={busy}
            spellCheck={false}
            maxLength={100000}
            onChange={(event) => { setRules(event.currentTarget.value); setSuggestions(undefined); }}
          />
        </details>
        {error && <p role="alert">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-border/60 pt-4">
          <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={() => { load(); setFormOpen(false); }}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={busy || instructions.length > maximumInstructions}>
            {t("timeWorkspace.guidelineSave")}
          </Button>
        </div>
      </form></Surface>}
    </section>
  );
}
