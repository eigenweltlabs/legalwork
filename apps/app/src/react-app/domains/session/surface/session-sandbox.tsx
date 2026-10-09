import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Shield, ShieldOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SandboxNetworkControl } from "../../settings/panels/sandbox-status";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function SessionSandbox({ client, workspaceId, sessionId }: { client: LegalworkServerClient; workspaceId: string; sessionId: string }) {
  const query = useQuery({ queryKey: ["session-sandbox", client.baseUrl, workspaceId, sessionId], queryFn: () => client.sessionSandbox(workspaceId, sessionId), refetchInterval: 5000 });
  const state = query.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state?.supported) return null;
  const save = async (settings: { enabled: boolean; networkMode: "allow" | "block" | "approve" } | null) => {
    setBusy(true); setError(null);
    try { await client.setSessionSandbox(workspaceId, sessionId, settings); await query.refetch(); }
    catch (error) { setError(error instanceof Error ? error.message : t("sandbox.network_save_failed")); }
    finally { setBusy(false); }
  };
  const items = [
    { value: "inherit", label: t("sandbox.inherit") },
    { value: "off", label: t("sandbox.off") },
    { value: "on", label: t("sandbox.on") },
  ];
  const Icon = state.enabled ? Shield : ShieldOff;
  return <Popover>
    <PopoverTrigger className="lw-composer-control inline-flex h-9 items-center gap-1.5 px-2.5 text-[13px] text-gray-10 hover:bg-gray-3 hover:text-gray-12" aria-label={t("sandbox.session_title")}>
      <Icon size={14} /><span>{state.enabled ? t("sandbox.on") : t("sandbox.off")}</span>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" className="w-80">
      <PopoverTitle>{t("sandbox.session_title")}</PopoverTitle>
      <p className="text-sm text-subtext">{t("sandbox.session_scope")}</p>
      <Select value={state.source === "session" ? state.enabled ? "on" : "off" : "inherit"} items={items} disabled={busy || !client.canApprove} onValueChange={value => {
        if (value === "inherit") void save(null);
        else if (value === "on" || value === "off") void save({ enabled: value === "on", networkMode: state.networkMode });
      }}>
        <SelectTrigger aria-label={t("sandbox.session_title")}><SelectValue /></SelectTrigger>
        <SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
      <p className="text-xs text-subtext">{state.source === "parent" ? t("sandbox.parent_scope") : state.source === "application" ? t("sandbox.using_default") : t("sandbox.using_override")}</p>
      {state.enabled ? <SandboxNetworkControl value={state.networkMode} disabled={busy || !client.canApprove} onChange={networkMode => { void save({ enabled: true, networkMode }); }} /> : <p className="text-sm text-subtext">{t("sandbox.off_description")}</p>}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </PopoverContent>
  </Popover>;
}
