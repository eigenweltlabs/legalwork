import { useMemo } from "react";
import {
  bindingTimeTerm,
  appliedTimePolicies,
  projectRelaxesTerm,
  type BindingTimeTerm,
  resolveTimePolicy,
  type TimeEntry,
  type TimePolicy,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";

export type BillingContext = { clientId: string; matterId: string; projectId?: string; date: string };
type Effective = ReturnType<typeof resolveTimePolicy>;
const fields = [
  "enforceIncrement",
  "incrementMinutes",
  "rounding",
  "maxMinutes",
  "language",
  "actionFirst",
  "narrativeExample",
  "reviewerId",
  "soloApproval",
  "hourlyRate",
  "currency",
] as const;
type Field = (typeof fields)[number];
const labels = {
  enforceIncrement: "enforce",
  incrementMinutes: "increment",
  rounding: "rounding",
  maxMinutes: "maximum",
  language: "language",
  actionFirst: "action_first",
  narrativeExample: "example",
  soloApproval: "solo",
  reviewerId: "reviewer",
  hourlyRate: "hourly_rate",
  currency: "currency",
};
function applicable(policies: TimePolicy[], c: BillingContext) {
  const scopes = { firm: "firm", client: c.clientId, matter: c.matterId, project: c.projectId };
  return (["firm", "client", "matter", "project"] as const).flatMap((scope) =>
    appliedTimePolicies(policies, scope, scopes[scope], c.date, c.clientId),
  );
}
function valueOf(key: Field, effective: Effective, state: TimesheetState) {
  const value = effective[key];
  if (key === "rounding") return t("back_office.billing.round_" + value);
  if (typeof value === "boolean") return t(value ? "back_office.billing.on" : "back_office.billing.off");
  if (key === "reviewerId" && value)
    return state.people.find((p) => p.id === value)?.name || String(value);
  return value === undefined || value === "" ? "–" : String(value);
}
function origin(key: Field, sources: TimePolicy[], effective: Effective) {
  if (
    (key === "enforceIncrement" ||
      (key === "incrementMinutes" &&
        effective.incrementMinutes === effective.bindingClientTerm?.incrementMinutes)) &&
    effective.bindingClientTerm &&
    !effective.incrementException
  ) {
    return sources.findLast(
      (p) =>
        p.scope === "client" &&
        p.targetId === effective.bindingClientTerm?.clientId &&
        p.bindingIncrement === true,
    );
  }
  return Array.from(sources)
    .reverse()
    .find((p) => p[key] !== undefined);
}
export function EffectiveTerms({ state, context }: { state: TimesheetState; context: BillingContext }) {
  const sources = applicable(state.policies, context);
  const effective = resolveTimePolicy(
    state.policies,
    context.clientId,
    context.matterId,
    context.date,
    context.projectId,
  );
  const display = fields.map((key) => ({
    id: key as string,
    label: t("back_office.billing." + labels[key]),
    value: valueOf(key, effective, state),
    from: origin(key, sources, effective),
  }));
  const maps = {
    activityLimits: "exceptions",
    workerRates: "hourly_rate",
    actionWords: "action_word",
    narrativeCorrections: "preferred",
    activityLabels: "activity_label",
  } as const;
  for (const map of Object.keys(maps) as (keyof typeof maps)[]) {
    for (const [key, val] of Object.entries(effective[map])) {
      const from = sources.findLast((source) => source[map]?.[key] !== undefined);
      const context =
        map === "workerRates" ? (state.people.find((p) => p.id === key)?.name ?? key) : key;
      display.push({
        id: map + "/" + key,
        label: t("back_office.billing." + maps[map]) + " · " + context,
        value: String(val),
        from,
      });
    }
  }
  return (
    <details>
      <summary>{t("back_office.billing.effective_terms")}</summary>
      <table>
        <thead>
          <tr>
            {["rule", "value", "source", "effective"].map((k) => (
              <th key={k}>{t("back_office.billing." + k)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {display.map(({ id, label, value, from }) => {
            const entity =
              from?.scope === "client"
                ? state.clients
                : from?.scope === "matter"
                  ? state.matters
                  : from?.scope === "project"
                    ? state.projects
                    : [];
            const name = entity.find((i) => i.id === from?.targetId)?.name;
            const legacyAgreement = from?.effectiveFrom === "0001-01-01" && from.revision === 0;
            const source = legacyAgreement
              ? t("back_office.feeAgreements.singular")
              : from
                ? t("back_office.billing.scope_" + from.scope)
                : t("back_office.billing.default");
            return (
              <tr key={id}>
                <td>{label}</td>
                <td>{value}</td>
                <td>
                  {source}
                  {name && " · " + name}
                </td>
                <td>{legacyAgreement ? "–" : (from?.effectiveFrom ?? "–")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {effective.bindingClientTerm && <p>{boundText(effective.bindingClientTerm)}</p>}
      {effective.incrementException && (
        <p>
          {t("back_office.billing.authorized_exception", {
            reason: effective.incrementException.reason,
            who:
              state.people.find((person) => person.id === effective.incrementException?.authorizedBy)
                ?.name ?? effective.incrementException.authorizedBy,
            when: new Date(effective.incrementException.authorizedAt).toLocaleDateString(),
          })}
        </p>
      )}
    </details>
  );
}
function boundText(term: BindingTimeTerm) {
  return term.effectiveFrom === "0001-01-01" && term.revision === 0
    ? t("back_office.billing.bound_agreement", { unit: term.incrementMinutes })
    : t("back_office.billing.bound_to", { unit: term.incrementMinutes, date: term.effectiveFrom });
}
function signature(entry: TimeEntry, policy: Effective) {
  return {
    grid: policy.enforceIncrement ? String(policy.incrementMinutes) : t("back_office.billing.free"),
    rounding: policy.enforceIncrement ? t("back_office.billing.round_" + policy.rounding) : "–",
    cap: String(policy.activityLimits[entry.activity] ?? policy.maxMinutes),
    binding: policy.bindingClientTerm
      ? policy.incrementException
        ? t("back_office.billing.authorized")
        : t("back_office.billing.bound")
      : "–",
    language: policy.language,
    words: JSON.stringify([
      policy.actionFirst,
      policy.actionWords[entry.activity],
      policy.narrativeCorrections,
      policy.narrativeExample,
    ]),
    activity: policy.activityLabels[entry.activity] ?? entry.activity,
    solo: policy.soloApproval ? t("back_office.billing.on") : t("back_office.billing.off"),
    reviewer: policy.reviewerId,
    rate: [policy.workerRates[entry.workerId] ?? policy.hourlyRate, policy.currency]
      .filter((v) => v !== undefined)
      .join(" "),
  };
}
export function projectBindingTerms(state: TimesheetState, policy: TimePolicy) {
  if (policy.scope !== "project") return [];
  const project = state.projects.find((p) => p.id === policy.targetId);
  if (!project) return [];
  const clients = new Set(
    state.matters.filter((m) => project.matterIds.includes(m.id)).flatMap((m) => m.clientIds),
  );
  return [...clients].flatMap((id) => {
    const term = bindingTimeTerm(state.policies, id, policy.effectiveFrom);
    return term && projectRelaxesTerm(policy, term) ? [term] : [];
  });
}
export function BindingTerms({
  state,
  terms,
  value,
  onChange,
}: {
  state: TimesheetState;
  terms: BindingTimeTerm[];
  value: string;
  onChange: (reason: string) => void;
}) {
  return (
    <div className="bo-billing-binding">
      <strong>{t("back_office.billing.exception_needed")}</strong>
      {terms.map((term) => (
        <p key={term.clientId}>
          {state.clients.find((c) => c.id === term.clientId)?.name ?? term.clientId} · {boundText(term)}
        </p>
      ))}
      <label>
        {t("back_office.billing.exception_reason")}
        <textarea required maxLength={2000} value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
      <small>{t("back_office.billing.exception_authority")}</small>
    </div>
  );
}
export function openBillingImpact(state: TimesheetState, policy: TimePolicy, entries: TimeEntry[]) {
  // The preview models a grant matching this draft; it is never placed in a policy command.
  const terms = projectBindingTerms(state, policy);
  const draft: TimePolicy = {
    ...policy,
    revision: policy.revision + 1,
    ...(terms.length
      ? {
          incrementException: {
            reason: "preview",
            authorizedBy: state.userId,
            authorizedAt: policy.effectiveFrom + "T00:00:00Z",
            terms,
          },
        }
      : {}),
  };
  const proposal = [
    ...state.policies.filter(
      (p) =>
        !(
          p.scope === policy.scope &&
          p.targetId === policy.targetId &&
          p.effectiveFrom === policy.effectiveFrom &&
          p.revision !== 0
        ),
    ),
    draft,
  ];
  return entries.flatMap((entry) => {
    if (
      !["confirmed", "pending", "submitted"].includes(entry.status) ||
      entry.date < policy.effectiveFrom
    )
      return [];
    const get = (terms: TimePolicy[]) =>
      resolveTimePolicy(terms, entry.clientId, entry.matterId, entry.date, entry.projectId);
    const old = signature(entry, get(state.policies)),
      next = signature(entry, get(proposal));
    const diffs = (
      [
        "grid",
        "rounding",
        "cap",
        "binding",
        "language",
        "words",
        "activity",
        "solo",
        "reviewer",
        "rate",
      ] as const
    )
      .filter((k) => old[k] !== next[k])
      .map((k) => ({ key: k, from: old[k], to: next[k] }));
    return diffs.length ? [{ entry, diffs }] : [];
  });
}
export function BillingImpact({
  state,
  policy,
  entries,
}: {
  state: TimesheetState;
  policy: TimePolicy;
  entries: TimeEntry[];
}) {
  const rows = useMemo(() => openBillingImpact(state, policy, entries), [state, policy, entries]);
  return (
    <details>
      <summary>{t("back_office.billing.changed_lines", { count: rows.length })}</summary>
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              {["date", "narrative", "changed_rules"].map((k) => (
                <th key={k}>{t("back_office.billing." + k)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, diffs }) => (
              <tr key={entry.id}>
                <td>{entry.date}</td>
                <td>{entry.narrative}</td>
                <td>
                  {diffs.map((d) => {
                    const mapPerson = (id: string) => state.people.find((p) => p.id === id)?.name || id;
                    const format = (value: string) =>
                      d.key === "reviewer" ? mapPerson(value) || "–" : value || "–";
                    return (
                      <div key={d.key}>
                        {t(
                          d.key === "rounding"
                            ? "back_office.billing.rounding"
                            : "back_office.billing.change_" + d.key,
                        )}
                        {d.key !== "words" && " · " + format(d.from) + " → " + format(d.to)}
                      </div>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <small>{t("back_office.billing.preview_note")}</small>
    </details>
  );
}
