import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import type { UsageControlAction, UsageRequestKind } from "@legalwork/types/usage-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseUsageAmount, type Run, type Text } from "./transport";

const fieldClass = "h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground";
function requestKind(value: string): UsageRequestKind {
  if (value === "temporary" || value === "recurring" || value === "upgrade") return value;
  throw new Error("kind");
}
export function UsageRequestForm({ run, busy, t, initialKind = "temporary" }: {
  run: Run; busy: boolean; t: Text; initialKind?: UsageRequestKind;
}) {
  const [kind, setKind] = useState<UsageRequestKind>(initialKind);
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    const form = new FormData(event.currentTarget);
    let action: UsageControlAction;
    try {
      action = { action: "request", kind, amountCents: kind === "upgrade" ? 0 : parseUsageAmount(form.get("amount")), reason: String(form.get("reason") ?? "") };
    } catch {
      setError(t("limits.invalid_amount"));
      return;
    }
    void run(action).catch(() => setError(t("limits.action_error")));
  }
  return <form className="space-y-4" onSubmit={submit} aria-busy={busy}>
    <label className="grid gap-2 text-sm">{t("limits.kind")}<select name="kind" className={fieldClass} value={kind} disabled={busy} onChange={event => setKind(requestKind(event.target.value))}>
      <option value="temporary">{t("limits.temporary")}</option><option value="recurring">{t("limits.recurring")}</option><option value="upgrade">{t("limits.upgrade")}</option>
    </select></label>
    {kind !== "upgrade" && <label className="grid gap-2 text-sm">{t("limits.amount")}<Input name="amount" inputMode="decimal" defaultValue="30" disabled={busy} /></label>}
    <label className="grid gap-2 text-sm">{t("limits.reason")}<Input name="reason" maxLength={1000} disabled={busy} /></label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="submit" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{t("limits.send")}</Button>
  </form>;
}
