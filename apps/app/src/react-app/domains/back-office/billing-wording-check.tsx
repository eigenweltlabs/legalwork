import { useId, useState } from "react";
import { Button } from "twenty-ui/primitives/input";
import { checkBillingNarrative } from "@legalwork/types/billing-narrative";
import {
  resolveTimePolicy,
  type TimeEntry,
  type TimesheetCommand,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";

type Changes = Extract<TimesheetCommand, { type: "applyWording" }>["entries"];

type PreviewLine = { change: Changes[number]; date: string; worker: string; rules: string[] };

export function BillingWordingCheck({
  selected,
  policies,
  people,
  disabled,
  apply,
}: {
  selected: TimeEntry[];
  policies: TimesheetState["policies"];
  people: ReadonlyMap<string, string>;
  disabled: boolean;
  apply: (changes: Changes) => Promise<void>;
}) {
  const previewId = useId();
  const [preview, setPreview] = useState<PreviewLine[]>();
  function check() {
    setPreview(
      selected.flatMap((entry) => {
        const { id, revision, clientId, matterId, date, projectId, workerId, narrative } = entry;
        const policy = resolveTimePolicy(policies, clientId, matterId, date, projectId);
        const result = checkBillingNarrative(entry, policy);
        if (!result) return [];
        const rules = [...result.replacements].map(([from, to]) => from + " → " + to);
        if (result.actionFirst) rules.push(t("back_office.billing.action_first"));
        return [{
          change: { id, revision, before: narrative, after: result.narrative },
          date,
          worker: people.get(workerId) ?? workerId,
          rules,
        }];
      }),
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        aria-expanded={!!preview}
        aria-controls={preview ? previewId : undefined}
        onClick={check}
      >
        {t("back_office.billing.check_text")}
      </Button>
      {preview && (
        <div id={previewId} className="bo-billing-wording-preview">
          {preview.length ? (
            <>
              <table>
                <thead>
                  <tr>
                    <th>{t("back_office.billing.date")}</th>
                    <th>{t("back_office.billing.worker")}</th>
                    <th>{t("back_office.billing.wording_rule")}</th>
                    <th>{t("back_office.billing.current_wording")}</th>
                    <th>{t("back_office.billing.suggestion")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map(({ change, date, worker, rules }) => (
                    <tr key={change.id}>
                      <td>{date}</td>
                      <td>{worker}</td>
                      <td>{rules.join(" · ")}</td>
                      <td>{change.before}</td>
                      <td>{change.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void apply(preview.map((item) => item.change)).catch(() => {})}
              >
                {t("back_office.billing.apply_previewed", { count: preview.length })}
              </Button>
            </>
          ) : (
            <p role="status">{t("back_office.billing.no_wording_changes", { count: selected.length })}</p>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPreview(undefined)}>
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </>
  );
}
