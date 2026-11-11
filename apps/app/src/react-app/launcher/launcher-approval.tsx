import { useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { LauncherApprovalRequest } from "@legalwork/types/launcher";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { handleLauncherFocusKey } from "./launcher-focus";

/**
 * A host approval as system UI inside the panel. Deny is the default; the only
 * ways out are the two buttons or closing the panel, which hands the request
 * back to the main window unanswered.
 */
export function LauncherApprovalCard({ request, onReply }: { request: LauncherApprovalRequest; onReply: (id: string, decision: "allow" | "deny") => Promise<void> }) {
  const denyRef = useRef<HTMLButtonElement>(null);
  const replying = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); denyRef.current?.focus(); }, [request.id]);
  const reply = async (decision: "allow" | "deny") => {
    if (replying.current) return;
    replying.current = true; setBusy(true); setError(null);
    try { await onReply(request.id, decision); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { replying.current = false; setBusy(false); }
  };
  const rows: [string, string][] = [[t("launcher.approval.source"), request.source], ...(request.scope ? [[t("launcher.approval.scope"), request.scope] as [string, string]] : []), [t("launcher.approval.workspace"), request.workspaceId], [t("launcher.approval.action"), request.action]];
  return <section className="launcher-attention launcher-approval" role="alertdialog" aria-labelledby={`approval-${request.id}`} aria-describedby={`approval-${request.id}-summary`} onKeyDown={event => { handleLauncherFocusKey(event, event.currentTarget, true); if (event.key !== "Escape") event.stopPropagation(); }}>
    <div className="launcher-attention-head"><strong id={`approval-${request.id}`}><ShieldAlert className="mr-1 inline size-4" />{t("launcher.approval.title")}</strong>{request.summary ? <span id={`approval-${request.id}-summary`}>{request.summary}</span> : null}</div>
    <div className="space-y-1 p-3 text-xs">
      {rows.map(([label, value]) => <div key={label} className="flex gap-2"><span className="w-16 shrink-0 text-muted-foreground">{label}</span><span className="break-all">{value}</span></div>)}
      {request.paths.length > 0 && <div className="flex gap-2"><span className="w-16 shrink-0 text-muted-foreground">{t("launcher.approval.paths")}</span><pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all">{request.paths.join("\n")}</pre></div>}
      <p className="pt-1 text-muted-foreground">{t("launcher.approval.hint")}</p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-1"><Button ref={denyRef} variant="outline" size="sm" disabled={busy} onClick={() => void reply("deny")}>{t("launcher.approval.deny")}</Button><Button size="sm" disabled={busy} onClick={() => void reply("allow")}>{t("launcher.approval.allow")}</Button></div>
    </div>
  </section>;
}
