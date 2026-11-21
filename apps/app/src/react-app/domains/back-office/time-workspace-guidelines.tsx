import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
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
  guidelines,
  state,
  pending,
  save,
  readPdf,
  extractRules,
}: {
  date: string;
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
  const [editing, setEditing] = useState<Guideline>();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("firm");
  const [target, setTarget] = useState("");
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
  for (const guideline of guidelines) {
    if ((latest.get(guideline.id)?.revision ?? -1) < guideline.revision)
      latest.set(guideline.id, guideline);
  }
  function load(guideline?: Guideline) {
    setEditing(guideline);
    setName(guideline?.name ?? "");
    setScope(guideline?.scope ?? "firm");
    setTarget(guideline?.targetId ?? "");
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
      if (await save({ type: "guideline", guideline: parsed.data })) load();
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
  return (
    <details className="time-workspace-guidelines">
      <summary>{t("timeWorkspace.guidelines")}</summary>
      <p className="time-workspace-note">{t("timeWorkspace.guidelineHint")}</p>
      {latest.size > 0 && (
        <label className="time-workspace-field">
          {t("timeWorkspace.guidelineVersion")}
          <select
            value={editing?.id ?? ""}
            disabled={busy}
            onChange={(event) => load(latest.get(event.currentTarget.value))}
          >
            <option value="">{t("timeWorkspace.guidelineNew")}</option>
            {[...latest.values()].map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · v{item.revision}
              </option>
            ))}
          </select>
        </label>
      )}
      <form
        className="time-workspace-form"
        onSubmit={(event) => void submit(event)}
      >
        <label>
          {t("timeWorkspace.guidelineName")}
          <input
            value={name}
            required
            maxLength={240}
            disabled={busy}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          {t("timeWorkspace.guidelineScope")}
          <select
            value={scope}
            disabled={busy}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (next === "firm" || next === "matter" || next === "client")
                setScope(next);
              setTarget("");
            }}
          >
            <option value="firm">{t(scopeKeys.firm)}</option>
            <option value="client">{t(scopeKeys.client)}</option>
            <option value="matter">{t(scopeKeys.matter)}</option>
          </select>
        </label>
        {scope !== "firm" && (
          <label>
            {t(scopeKeys[scope])}
            <select
              value={target}
              required
              disabled={busy}
              onChange={(event) => setTarget(event.currentTarget.value)}
            >
              <option value="" />
              {(scope === "client" ? state.clients : state.matters).map(
                (item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ),
              )}
            </select>
          </label>
        )}
        <label>
          {t("timeWorkspace.guidelineEffective")}
          <input
            type="date"
            value={effective}
            required
            disabled={busy}
            onChange={(event) => setEffective(event.currentTarget.value)}
          />
        </label>
        <label>
          {t("timeWorkspace.guidelineFile")}
          <input
            type="file"
            accept=".txt,.docx,.pdf,.json"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void preview(file);
            }}
          />
        </label>
        {loadingFile && (
          <p role="status">{t("timeWorkspace.guidelineReading")}</p>
        )}
        {loadingRules && <p role="status">{t("timeWorkspace.guidelineExtracting")}</p>}
        {sourceWarning && <p role="status">{sourceWarning}</p>}
        <label>
          {t("timeWorkspace.guidelineText")}
          <textarea
            rows={5}
            value={instructions}
            disabled={busy}
            onChange={(event) => { setInstructions(event.currentTarget.value); setSuggestions(undefined); }}
          />
        </label>
        {instructions.length > maximumInstructions && (
          <p role="alert">{t("timeWorkspace.guidelineTextSize")}</p>
        )}
        {extractRules && <Button type="button" size="sm" variant="outline" disabled={busy || !instructions.trim() || instructions.length > maximumInstructions}
          onClick={() => {
            extraction.current?.abort();
            const controller = new AbortController(); extraction.current = controller;
            setError(""); void inferRules(instructions, controller);
          }}>{t("timeWorkspace.guidelineExtract")}</Button>}
        <fieldset disabled={busy} className="grid gap-3">
          <legend>{t("timeWorkspace.guidelineTimeRules")}</legend>
          {(["minimumMinutes", "maxMinutes", "incrementMinutes"] as const).map(field => <label key={field}>
            {t("timeWorkspace." + field)}
            <input type="number" min="1" max="1440" value={currentRules?.[field] ?? ""}
              onChange={event => updateRule(field, event.currentTarget.value ? Number(event.currentTarget.value) : undefined)} />
          </label>)}
          <label>{t("back_office.billing.rounding")}
            <select value={currentRules?.rounding ?? ""} onChange={event => updateRule("rounding", event.currentTarget.value || undefined)}>
              <option value="">{t("timeWorkspace.guidelineInherited")}</option>
              {(["choose", "up", "down", "nearest"] as const).map(mode => <option key={mode} value={mode}>{t(roundingKeys[mode])}</option>)}
            </select>
          </label>
          <label>{t("timeWorkspace.guidelineEnforceIncrement")}
            <select value={currentRules?.enforceIncrement === undefined ? "" : String(currentRules.enforceIncrement)}
              onChange={event => updateRule("enforceIncrement", event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true")}>
              <option value="">{t("timeWorkspace.guidelineInherited")}</option>
              <option value="true">{t("timeWorkspace.guidelineYes")}</option><option value="false">{t("timeWorkspace.guidelineNo")}</option>
            </select>
          </label>
        </fieldset>
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
          <textarea
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
        <Button
          type="submit"
          size="sm"
          disabled={busy || instructions.length > maximumInstructions}
        >
          {t("timeWorkspace.guidelineSave")}
        </Button>
      </form>
    </details>
  );
}
