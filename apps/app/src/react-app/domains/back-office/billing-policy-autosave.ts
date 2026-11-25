import { useRef, useState } from "react";
import { TimePolicySchema, type TimePolicy } from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import type { BillingProps } from "./billing-components";

function samePolicy(first: TimePolicy, second: TimePolicy) {
  return JSON.stringify(first) === JSON.stringify(second);
}

export function useBillingPolicyAutosave(base: TimePolicy, onCommand: BillingProps["onCommand"]) {
  const [saved, setSaved] = useState<TimePolicy>();
  const [draft, stage] = useState<TimePolicy>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const active = useRef(false);
  const queued = useRef<TimePolicy | undefined>(undefined);
  const baseline = saved && saved.revision > base.revision ? saved : base;
  const policy = draft ?? baseline;

  async function save(value: TimePolicy) {
    const parsed = TimePolicySchema.safeParse(value);
    if (!parsed.success) {
      setInvalid(true);
      return false;
    }
    setInvalid(false);
    const initial = TimePolicySchema.parse(baseline);
    if (!active.current && samePolicy(parsed.data, initial)) {
      stage(undefined);
      setError("");
      return true;
    }
    queued.current = parsed.data;
    if (active.current) return false;

    active.current = true;
    setPending(true);
    setError("");
    let revision = parsed.data.revision;
    let acknowledged = initial;
    try {
      while (queued.current) {
        const next: TimePolicy = { ...queued.current, revision };
        queued.current = undefined;
        if (!samePolicy(next, acknowledged)) {
          await onCommand({ type: "policy", policy: next });
          acknowledged = { ...next, revision: ++revision };
          setSaved(acknowledged);
        }
        const persisted = acknowledged;
        stage(current => {
          if (!current) return current;
          const normalized = TimePolicySchema.safeParse({ ...current, revision: persisted.revision });
          return normalized.success && samePolicy(normalized.data, persisted)
            ? undefined : { ...current, revision: persisted.revision };
        });
      }
      return true;
    } catch (failure) {
      queued.current = undefined;
      setError(failure instanceof Error ? failure.message : t("back_office.billing.save_failed"));
      return false;
    } finally {
      active.current = false;
      setPending(false);
    }
  }

  return { policy, stage, save, pending, error, invalid, dirty: Boolean(draft) };
}
