import { roundingKeys, scopeKeys } from "./timesheet-labels";
import { BillingTemplate } from "./billing-template";
import { cloneElement, useId, useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LayoutStack, LayoutSectionItem } from "../settings/settings-layout";
import { TimeSelect, TimeSetting, TimeSettingsGroup, TimeSwitch } from "./time-settings-controls";
import { BillingWordRules } from "./billing-word-rules";
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
import { useBillingAction, type BillingProps } from "./billing-components";
import { reviewPeriod } from "./billing-amounts";
import "./billing-review.css";

type Scope = TimePolicy["scope"];
const scopes = ["firm", "client", "matter", "project"] as const;

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
    <TimeSwitch
      label={label}
      checked={value ?? inherited}
      disabled={disabled}
      onChange={onChange}
      description={
        value === undefined ? (
          t("back_office.billing.inherited")
        ) : (
          <button
            type="button"
            className="text-muted-foreground underline underline-offset-2"
            disabled={disabled}
            onClick={() => onChange(undefined)}
          >
            {t("back_office.billing.inherit")}
          </button>
        )
      }
    />
  );
}
function Rule({
  name,
  children,
  description,
}: {
  name: string;
  children: ReactElement<{ id?: string }>;
  description?: string;
}) {
  const id = useId();
  return (
    <TimeSetting title={<label htmlFor={id}>{name}</label>} description={description}>
      {cloneElement(children, { id })}
    </TimeSetting>
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
  const clientBound = scope === "client" && (policy.bindingIncrement ?? Boolean(inherited.bindingClientTerm));
  const strict = policy.enforceIncrement ?? inherited.enforceIncrement;
  const increment = policy.incrementMinutes ?? inherited.incrementMinutes;
  const bindingTerms = projectBindingTerms(state, policy);
  const needsReason = bindingTerms.length > 0 && !policy.incrementExceptionReason?.trim();
  const readOnly = !state.canManage || pending;
  return (
    <form
      className="bo-time-policy"
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
      <fieldset disabled={readOnly} aria-label={t("timesheets.settings")}>
        <LayoutStack>
          <TimeSettingsGroup title={t("timesheets.review_assignment")}>
            <Rule name={t("back_office.billing.reviewer")} description={t("timesheets.assignment_hint")}>
              <TimeSelect
                label={t("back_office.billing.reviewer")}
                disabled={readOnly}
                value={policy.reviewerId ?? ""}
                options={[
                  {
                    id: "",
                    name: t("back_office.billing.inherit_value", {
                      value:
                        state.people.find((p) => p.id === inherited.reviewerId)?.name ||
                        t("back_office.billing.unassigned"),
                    }),
                  },
                  ...state.people.filter((p) => !p.directoryOnly),
                ]}
                onChange={(next) => update("reviewerId", next || undefined)}
              />
            </Rule>
            {scope === "firm" && state.scope === "local" && (
              <InheritableToggle
                label={t("back_office.billing.solo")}
                disabled={readOnly}
                value={policy.soloApproval}
                inherited={false}
                onChange={(v) => update("soloApproval", v)}
              />
            )}
          </TimeSettingsGroup>
          <TimeSettingsGroup title={t("back_office.billing.time_rules")}>
            {scope === "client" && (
              <TimeSwitch
                label={t("back_office.billing.binding")}
                disabled={readOnly}
                checked={clientBound}
                onChange={(v) =>
                  setPolicy((old) => ({
                    ...old,
                    bindingIncrement: v,
                    enforceIncrement: v ? true : old.enforceIncrement,
                  }))
                }
              />
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
              disabled={readOnly || clientBound}
              value={clientBound ? true : policy.enforceIncrement}
              inherited={inherited.enforceIncrement}
              onChange={(v) => update("enforceIncrement", v)}
            />
            <Rule
              name={t("back_office.billing.increment")}
              description={
                strict
                  ? t("back_office.billing.examples", { a: increment, b: increment * 2, c: increment * 3 })
                  : t("back_office.billing.free_minutes")
              }
            >
              <Input
                type="number"
                min={1}
                max={1440}
                step={1}
                value={policy.incrementMinutes ?? ""}
                placeholder={String(inherited.incrementMinutes)}
                onChange={(e) => update("incrementMinutes", rateValue(e.target.value))}
              />
            </Rule>
            <Rule name={t("back_office.billing.rounding")}>
              <TimeSelect
                label={t("back_office.billing.rounding")}
                disabled={readOnly}
                value={policy.rounding ?? ""}
                options={[
                  {
                    id: "",
                    name: t("back_office.billing.inherit_value", {
                      value: t(roundingKeys[inherited.rounding]),
                    }),
                  },
                  ...roundingModes.map((mode) => ({ id: mode, name: t(roundingKeys[mode]) })),
                ]}
                onChange={(next) =>
                  update(
                    "rounding",
                    roundingModes.find((mode) => mode === next),
                  )
                }
              />
            </Rule>
            <Rule name={t("back_office.billing.maximum")}>
              <Input
                type="number"
                min={1}
                max={1440}
                step={1}
                value={policy.maxMinutes ?? ""}
                placeholder={String(inherited.maxMinutes)}
                onChange={(e) => update("maxMinutes", rateValue(e.target.value))}
              />
            </Rule>
            <LayoutSectionItem>
              <details>
                <summary>{t("back_office.billing.exceptions")}</summary>
                {Object.entries({ ...inherited.activityLimits, ...policy.activityLimits }).map(
                  ([code, val]) => (
                    <Rule key={code} name={code}>
                      <Input
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
                  ),
                )}
                <div className="bo-billing-subrow">
                  <Input
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
              </details>
            </LayoutSectionItem>
          </TimeSettingsGroup>
          <TimeSettingsGroup title={t("back_office.billing.invoice_words")}>
            <Rule name={t("back_office.billing.language")}>
              <Input
                placeholder={inherited.language}
                value={policy.language ?? ""}
                onChange={(e) => update("language", e.target.value || undefined)}
              />
            </Rule>
            {scope === "firm" && (
              <LayoutSectionItem>
                <BillingWordRules
                  label={t("back_office.billing.activity_labels")}
                  fromLabel={t("back_office.billing.activity_code")}
                  toLabel={t("back_office.billing.activity_label")}
                  values={policy.activityLabels}
                  inherited={inherited.activityLabels}
                  onChange={(labels) => update("activityLabels", labels)}
                />
              </LayoutSectionItem>
            )}
            <InheritableToggle
              label={t("back_office.billing.action_first")}
              disabled={readOnly}
              value={policy.actionFirst}
              inherited={inherited.actionFirst}
              onChange={(v) => update("actionFirst", v)}
            />
            <LayoutSectionItem>
              <BillingWordRules
                label={t("back_office.billing.action_words")}
                fromLabel={t("back_office.billing.activity_code")}
                toLabel={t("back_office.billing.action_word")}
                values={policy.actionWords}
                inherited={inherited.actionWords}
                onChange={(v) => update("actionWords", v)}
              />
            </LayoutSectionItem>
            <LayoutSectionItem>
              <BillingWordRules
                label={t("back_office.billing.word_rules")}
                fromLabel={t("back_office.billing.written")}
                toLabel={t("back_office.billing.preferred")}
                values={policy.narrativeCorrections}
                inherited={inherited.narrativeCorrections}
                onChange={(v) => update("narrativeCorrections", v)}
              />
            </LayoutSectionItem>
            <Rule name={t("back_office.billing.example")}>
              <Textarea
                maxLength={500}
                value={policy.narrativeExample ?? ""}
                placeholder={inherited.narrativeExample}
                onChange={(e) => update("narrativeExample", e.target.value || undefined)}
              />
            </Rule>
          </TimeSettingsGroup>
          <TimeSettingsGroup title={t("back_office.billing.fees")}>
            <Rule name={t("back_office.billing.currency")}>
              <Input
                maxLength={3}
                pattern="[A-Za-z]{3}"
                value={policy.currency ?? ""}
                placeholder={inherited.currency}
                onChange={(e) => update("currency", e.target.value.toUpperCase() || undefined)}
              />
            </Rule>
            <Rule name={t("back_office.billing.hourly_rate")}>
              <Input
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
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder={String(val)}
                  value={policy.workerRates?.[id] ?? ""}
                  onChange={(e) => updateMap("workerRates", id, rateValue(e.target.value))}
                />
              </Rule>
            ))}
            <LayoutSectionItem>
              <div className="bo-billing-subrow">
                <TimeSelect
                  label={t("back_office.billing.worker")}
                  value={worker}
                  disabled={readOnly}
                  options={[{ id: "", name: t("back_office.billing.worker") }, ...state.people]}
                  onChange={setWorker}
                />
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
            </LayoutSectionItem>
          </TimeSettingsGroup>
        </LayoutStack>
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
  initialDate,
}: BillingProps & {
  initialProjectId?: string;
  initialMatterId?: string;
  initialClientId?: string;
  initialDate?: string;
}) {
  const [scope, setScope] = useState<Scope>(
    initialProjectId ? "project" : initialMatterId ? "matter" : initialClientId ? "client" : "firm",
  );
  const [target, setTarget] = useState(initialProjectId || initialMatterId || initialClientId || "");
  const [date, setDate] = useState(() => initialDate ?? reviewPeriod().to);
  const [matterContext, setMatterContext] = useState("");
  const [clientContext, setClientContext] = useState("");
  const options = (s: Scope) =>
    s === "project" ? state.projects : s === "matter" ? state.matters : s === "client" ? state.clients : [];
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
    <section className="bo-billing bo-time-preferences">
      <div className="bo-view-toolbar">
        <label>{t("back_office.billing.scope")}
        <TimeSelect
          label={t("back_office.billing.scope")}
          value={scope}
          options={scopes.map((id) => ({ id, name: t(scopeKeys[id]) }))}
          onChange={(next) => {
            const item = scopes.find((scope) => scope === next);
            if (!item) return;
            setScope(item);
            setTarget(options(item)[0]?.id ?? "");
            setClientContext("");
            setMatterContext("");
          }}
        />
        </label>
        {scope !== "firm" && (
          <label>{t("back_office.billing.target")}<TimeSelect
            label={t("back_office.billing.target")}
            value={target}
            options={
              options(scope).some((p) => p.id === target)
                ? options(scope)
                : [{ id: target, name: t("back_office.billing.choose_target") }, ...options(scope)]
            }
            onChange={(id) => {
              setTarget(id);
              setClientContext("");
              setMatterContext("");
            }}
          /></label>
        )}
        {matters.length > 1 && (
          <TimeSelect
            label={t("back_office.billing.matter")}
            value={matter?.id ?? ""}
            options={matters}
            onChange={(id) => {
              setMatterContext(id);
              setClientContext("");
            }}
          />
        )}
        {clients.length > 1 && (
          <TimeSelect
            label={t("back_office.billing.client")}
            value={client?.id ?? ""}
            options={clients}
            onChange={setClientContext}
          />
        )}
        <label>
          {t("back_office.billing.effective")}
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
