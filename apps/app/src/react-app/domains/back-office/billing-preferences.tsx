import { BillingTemplate } from "./billing-template";
import { useState, type ReactNode } from "react";
import { Button } from "twenty-ui/primitives/input";
import { BillingWordRules } from "./billing-word-rules";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import {
  BindingTerms,
  BillingImpact,
  EffectiveTerms,
  projectBindingTerms,
  type BillingContext,
} from "./billing-impact";
import {
  appliedTimePolicies,
  roundingModes,
  resolveTimePolicy,
  type TimeEntry,
  type TimePolicy,
} from "@legalwork/types/timesheet";
import { BillingOptions, useBillingAction, type BillingProps } from "./billing-components";
import { reviewPeriod } from "./billing-amounts";
import "./billing-review.css";

type Scope = TimePolicy["scope"];

function InheritableToggle({
  label,
  value,
  inherited,
  disabled,
  onChange,
}: {
  label: string;
  value?: boolean;
  inherited: boolean;
  disabled?: boolean;
  onChange: (value: boolean | undefined) => void;
}) {
  return (
    <div className="bo-billing-rule">
      <span>{label}</span>
      <div>
        <Switch
          disabled={disabled}
          aria-label={label}
          checked={value ?? inherited}
          onCheckedChange={onChange}
        />
        {value === undefined ? (
          <small>{t("back_office.billing.inherited")}</small>
        ) : (
          <button
            type="button"
            disabled={disabled}
            className="bo-billing-muted"
            onClick={() => onChange(undefined)}
          >
            {t("back_office.billing.inherit")}
          </button>
        )}
      </div>
    </div>
  );
}
function Rule({ name, children }: { name: string; children: ReactNode }) {
  return (
    <label className="bo-billing-rule">
      <span>{name}</span>
      {children}
    </label>
  );
}
function rateValue(value: string) {
  return value.trim() ? Number(value) : undefined;
}

function PolicyForm({
  state,
  onCommand,
  scope,
  targetId,
  date,
  base,
  inherited,
  entriesAffected,
  context,
}: BillingProps & {
  scope: Scope;
  targetId: string;
  date: string;
  base?: TimePolicy;
  inherited: ReturnType<typeof resolveTimePolicy>;
  entriesAffected: TimeEntry[];
  context: BillingContext;
}) {
  const [policy, setPolicy] = useState<TimePolicy>(() => {
    const {
      incrementException: receipt,
      incrementExceptionReason: _oldReason,
      agreementClientId: _agreement,
      ...editable
    } = base ?? {};
    const draft = {
      ...editable,
      scope,
      targetId,
      effectiveFrom: date,
      revision: base?.effectiveFrom === date ? base.revision : 0,
    };
    if (base?.effectiveFrom === date && receipt) {
      const terms = projectBindingTerms(state, draft);
      const matches = terms.every((term) =>
        receipt.terms.some(
          (ref) =>
            ref.clientId === term.clientId &&
            ref.revision === term.revision &&
            ref.effectiveFrom === term.effectiveFrom &&
            ref.incrementMinutes === term.incrementMinutes,
        ),
      );
      if (terms.length > 0 && matches) return { ...draft, incrementExceptionReason: receipt.reason };
    }
    return draft;
  });
  const { send, pending, error } = useBillingAction(onCommand);
  const [message, setMessage] = useState("");
  const [limitCode, setLimitCode] = useState("");
  const [worker, setWorker] = useState("");
  function update<K extends keyof TimePolicy>(key: K, value: TimePolicy[K]) {
    setMessage("");
    setPolicy((old) => ({ ...old, [key]: value }));
  }
  function updateMap(key: "activityLimits" | "workerRates", id: string, value?: number) {
    const map = { ...policy[key] };
    if (value === undefined) delete map[id];
    else map[id] = value;
    update(key, Object.keys(map).length ? map : undefined);
  }
  const clientBound =
    scope === "client" && (policy.bindingIncrement ?? Boolean(inherited.bindingClientTerm));
  const strict = policy.enforceIncrement ?? inherited.enforceIncrement;
  const increment = policy.incrementMinutes ?? inherited.incrementMinutes;
  const bindingTerms = projectBindingTerms(state, policy);
  const needsReason = bindingTerms.length > 0 && !policy.incrementExceptionReason?.trim();
  return (
    <form
      className="bo-billing-rules"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!state.canManage || pending || needsReason) return;
        try {
          await send({ type: "policy", policy });
          setMessage(t("back_office.billing.saved"));
        } catch {
          /* Server message is shown below. */
        }
      }}
    >
      <fieldset disabled={!state.canManage || pending}>
        <legend>{t("back_office.billing.time_rules")}</legend>
        {scope === "client" && (
          <label className="bo-billing-rule">
            <span>{t("back_office.billing.binding")}</span>
            <Switch
              aria-label={t("back_office.billing.binding")}
              checked={clientBound}
              onCheckedChange={(v) =>
                setPolicy((old) => ({
                  ...old,
                  bindingIncrement: v,
                  enforceIncrement: v ? true : old.enforceIncrement,
                }))
              }
            />
          </label>
        )}
        {scope === "project" && bindingTerms.length > 0 && (
          <BindingTerms
            state={state}
            terms={bindingTerms}
            value={policy.incrementExceptionReason ?? ""}
            onChange={(reason) => update("incrementExceptionReason", reason || undefined)}
          />
        )}
        <InheritableToggle
          label={t("back_office.billing.enforce")}
          disabled={clientBound}
          value={clientBound ? true : policy.enforceIncrement}
          inherited={inherited.enforceIncrement}
          onChange={(v) => update("enforceIncrement", v)}
        />
        <Rule name={t("back_office.billing.increment")}>
          <input
            type="number"
            min={1}
            max={1440}
            step={1}
            value={policy.incrementMinutes ?? ""}
            placeholder={String(inherited.incrementMinutes)}
            onChange={(e) => update("incrementMinutes", rateValue(e.target.value))}
          />
        </Rule>
        <p className="bo-billing-muted">
          {strict
            ? t("back_office.billing.examples", { a: increment, b: increment * 2, c: increment * 3 })
            : t("back_office.billing.free_minutes")}
        </p>
        <Rule name={t("back_office.billing.rounding")}>
          <select
            value={policy.rounding ?? ""}
            onChange={(e) =>
              update(
                "rounding",
                roundingModes.find((value) => value === e.target.value),
              )
            }
          >
            <option value="">
              {t("back_office.billing.inherit_value", {
                value: t("back_office.billing.round_" + inherited.rounding),
              })}
            </option>
            {roundingModes.map((mode) => (
              <option key={mode} value={mode}>
                {t("back_office.billing.round_" + mode)}
              </option>
            ))}
          </select>
        </Rule>
        <Rule name={t("back_office.billing.maximum")}>
          <input
            type="number"
            min={1}
            max={1440}
            step={1}
            value={policy.maxMinutes ?? ""}
            placeholder={String(inherited.maxMinutes)}
            onChange={(e) => update("maxMinutes", rateValue(e.target.value))}
          />
        </Rule>
        <h3>{t("back_office.billing.exceptions")}</h3>
        {Object.entries({ ...inherited.activityLimits, ...policy.activityLimits }).map(([code, val]) => (
          <Rule key={code} name={code}>
            <input
              aria-label={t("back_office.billing.limit_for", { code })}
              type="number"
              min={1}
              step={1}
              max={1440}
              placeholder={String(val)}
              value={policy.activityLimits?.[code] ?? ""}
              onChange={(e) => updateMap("activityLimits", code, rateValue(e.target.value))}
            />
          </Rule>
        ))}
        <div className="bo-billing-subrow">
          <input
            aria-label={t("back_office.billing.activity_code")}
            placeholder={t("back_office.billing.activity_code")}
            value={limitCode}
            onChange={(e) => setLimitCode(e.target.value)}
            maxLength={20}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!limitCode.trim()}
            onClick={() => {
              updateMap(
                "activityLimits",
                limitCode.trim().toUpperCase(),
                policy.maxMinutes ?? inherited.maxMinutes,
              );
              setLimitCode("");
            }}
          >
            {t("back_office.billing.add_exception")}
          </Button>
        </div>
        <h3>{t("back_office.billing.invoice_words")}</h3>
        <Rule name={t("back_office.billing.language")}>
          <input
            placeholder={inherited.language}
            value={policy.language ?? ""}
            onChange={(e) => update("language", e.target.value || undefined)}
          />
        </Rule>
        {scope === "firm" && (
          <BillingWordRules
            label={t("back_office.billing.activity_labels")}
            fromLabel={t("back_office.billing.activity_code")}
            toLabel={t("back_office.billing.activity_label")}
            values={policy.activityLabels}
            inherited={inherited.activityLabels}
            onChange={(labels) => update("activityLabels", labels)}
          />
        )}
        <InheritableToggle
          label={t("back_office.billing.action_first")}
          value={policy.actionFirst}
          inherited={inherited.actionFirst}
          onChange={(v) => update("actionFirst", v)}
        />
        <BillingWordRules
          label={t("back_office.billing.action_words")}
          fromLabel={t("back_office.billing.activity_code")}
          toLabel={t("back_office.billing.action_word")}
          values={policy.actionWords}
          inherited={inherited.actionWords}
          onChange={(v) => update("actionWords", v)}
        />
        <BillingWordRules
          label={t("back_office.billing.word_rules")}
          fromLabel={t("back_office.billing.written")}
          toLabel={t("back_office.billing.preferred")}
          values={policy.narrativeCorrections}
          inherited={inherited.narrativeCorrections}
          onChange={(v) => update("narrativeCorrections", v)}
        />
        <Rule name={t("back_office.billing.example")}>
          <textarea
            maxLength={500}
            value={policy.narrativeExample ?? ""}
            placeholder={inherited.narrativeExample}
            onChange={(e) => update("narrativeExample", e.target.value || undefined)}
          />
        </Rule>
        <Rule name={t("back_office.billing.reviewer")}>
          <select
            value={policy.reviewerId ?? ""}
            onChange={(e) => update("reviewerId", e.target.value || undefined)}
          >
            <option value="">
              {t("back_office.billing.inherit_value", {
                value:
                  state.people.find((p) => p.id === inherited.reviewerId)?.name ||
                  t("back_office.billing.unassigned"),
              })}
            </option>
            <BillingOptions options={state.people} />
          </select>
        </Rule>
        {scope === "firm" && state.scope === "local" && (
          <InheritableToggle
            label={t("back_office.billing.solo")}
            value={policy.soloApproval}
            inherited={false}
            onChange={(v) => update("soloApproval", v)}
          />
        )}
        <h3>{t("back_office.billing.fees")}</h3>
        <Rule name={t("back_office.billing.currency")}>
          <input
            maxLength={3}
            pattern="[A-Za-z]{3}"
            value={policy.currency ?? ""}
            placeholder={inherited.currency}
            onChange={(e) => update("currency", e.target.value.toUpperCase() || undefined)}
          />
        </Rule>
        <Rule name={t("back_office.billing.hourly_rate")}>
          <input
            type="number"
            step="0.01"
            min={0}
            value={policy.hourlyRate ?? ""}
            placeholder={inherited.hourlyRate?.toString()}
            onChange={(e) => update("hourlyRate", rateValue(e.target.value))}
          />
        </Rule>
        {Object.entries({ ...inherited.workerRates, ...policy.workerRates }).map(([id, val]) => (
          <Rule key={id} name={state.people.find((p) => p.id === id)?.name || id}>
            <input
              type="number"
              min={0}
              step="0.01"
              placeholder={String(val)}
              value={policy.workerRates?.[id] ?? ""}
              onChange={(e) => updateMap("workerRates", id, rateValue(e.target.value))}
            />
          </Rule>
        ))}
        <div className="bo-billing-subrow">
          <select
            aria-label={t("back_office.billing.worker")}
            value={worker}
            onChange={(e) => setWorker(e.target.value)}
          >
            <option value="">{t("back_office.billing.worker")}</option>
            <BillingOptions options={state.people} />
          </select>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!worker}
            onClick={() => {
              updateMap("workerRates", worker, policy.hourlyRate ?? inherited.hourlyRate ?? 0);
              setWorker("");
            }}
          >
            {t("back_office.billing.add_rate")}
          </Button>
        </div>
      </fieldset>
      <EffectiveTerms state={state} context={context} />
      <BillingImpact state={state} policy={policy} entries={entriesAffected} />
      <div>
        {state.canManage && (
          <Button type="submit" size="sm" variant="outline" disabled={pending || needsReason}>
            {t("back_office.billing.save_terms")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="bo-billing-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </form>
  );
}

export function BillingPreferences({
  state,
  onCommand,
  initialProjectId,
  initialMatterId,
  initialClientId,
}: BillingProps & {
  initialProjectId?: string;
  initialMatterId?: string;
  initialClientId?: string;
}) {
  const [scope, setScope] = useState<Scope>(
    initialProjectId ? "project" : initialMatterId ? "matter" : initialClientId ? "client" : "firm",
  );
  const [target, setTarget] = useState(initialProjectId || initialMatterId || initialClientId || "");
  const [date, setDate] = useState(() => reviewPeriod().to);
  const [matterContext, setMatterContext] = useState("");
  const [clientContext, setClientContext] = useState("");
  const options = (s: Scope) =>
    s === "project"
      ? state.projects
      : s === "matter"
        ? state.matters
        : s === "client"
          ? state.clients
          : [];
  const project = scope === "project" ? state.projects.find((p) => p.id === target) : undefined;
  const matters = state.matters.filter((m) =>
    scope === "matter" ? m.id === target : project?.matterIds.includes(m.id),
  );
  const matter = matters.find((m) => m.id === matterContext) ?? matters[0];
  const clients = state.clients.filter((c) =>
    scope === "client" ? c.id === target : matter?.clientIds.includes(c.id),
  );
  const client = clients.find((c) => c.id === clientContext) ?? clients[0];
  const targetId = scope === "firm" ? "firm" : target;
  const editable = appliedTimePolicies(state.policies, scope, targetId, date, client?.id).findLast(
    (p) => p.revision > 0,
  );
  const inherited = resolveTimePolicy(
    state.policies.filter((p) => p.scope !== scope || p.targetId !== targetId || !p.revision),
    client?.id ?? "",
    matter?.id ?? "",
    date,
    project?.id,
  );
  const affected = state.entries.filter(
    (e) =>
      ["confirmed", "submitted", "pending"].includes(e.status) &&
      e.date >= date &&
      (scope === "firm" ||
        (scope === "project" ? e.projectId : scope === "matter" ? e.matterId : e.clientId) === targetId),
  );
  return (
    <section className="bo-billing">
      <div className="bo-view-toolbar">
        <select
          aria-label={t("back_office.billing.scope")}
          value={scope}
          onChange={(e) => {
            const item = (["firm", "client", "matter", "project"] as const).find(
              (k) => k === e.target.value,
            );
            if (item) {
              setScope(item);
              setTarget(options(item)[0]?.id ?? "");
              setClientContext("");
              setMatterContext("");
            }
          }}
        >
          {(["firm", "client", "matter", "project"] as const).map((k) => (
            <option key={k} value={k}>
              {t("back_office.billing.scope_" + k)}
            </option>
          ))}
        </select>
        {scope !== "firm" && (
          <select
            aria-label={t("back_office.billing.target")}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setClientContext("");
              setMatterContext("");
            }}
          >
            {!options(scope).some((p) => p.id === target) && (
              <option value={target}>{t("back_office.billing.choose_target")}</option>
            )}
            <BillingOptions options={options(scope)} />
          </select>
        )}
        {matters.length > 1 && (
          <select
            aria-label={t("back_office.billing.matter")}
            value={matter?.id}
            onChange={(e) => {
              setMatterContext(e.target.value);
              setClientContext("");
            }}
          >
            <BillingOptions options={matters} />
          </select>
        )}
        {clients.length > 1 && (
          <select
            aria-label={t("back_office.billing.client")}
            value={client?.id}
            onChange={(e) => setClientContext(e.target.value)}
          >
            <BillingOptions options={clients} />
          </select>
        )}
        <label>
          {t("back_office.billing.effective")}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="bo-billing-body">
        {!date || (scope !== "firm" && !options(scope).some((o) => o.id === target)) ? (
          <p className="bo-billing-notice">{t("back_office.billing.choose_target")}</p>
        ) : (
          <PolicyForm
            key={[scope, targetId, date, editable?.revision].join("/")}
            state={state}
            onCommand={onCommand}
            scope={scope}
            targetId={targetId}
            date={date}
            base={editable}
            inherited={inherited}
            entriesAffected={affected}
            context={{
              date,
              clientId: client?.id ?? "",
              matterId: matter?.id ?? "",
              projectId: project?.id,
            }}
          />
        )}
        {scope === "firm" && state.canManage && (
          <BillingTemplate key={state.template?.revision ?? 0} state={state} onCommand={onCommand} />
        )}
      </div>
    </section>
  );
}
