import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, RotateCcw, Shield, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SandboxNetworkItems, networkLabel } from "../../settings/panels/sandbox-network-control";
import { changeOrgPolicySetting } from "../../connections/org-policy";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function SessionSandbox({ client, workspaceId, sessionId }: { client: LegalworkServerClient; workspaceId: string; sessionId: string }) {
  // Server sandbox/policy events invalidate this query; background failures stay in the menu.
  const query = useQuery({ queryKey: ["session-sandbox", client.baseUrl, workspaceId, sessionId], queryFn: () => client.sessionSandbox(workspaceId, sessionId) });
  const state = query.isError ? undefined : query.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (settings: { enabled: boolean; networkMode: "allow" | "block" | "approve" } | null) => {
    setBusy(true); setError(null);
    try {
      const change = () => client.setSessionSandbox(workspaceId, sessionId, settings).then(() => undefined);
      if (state?.policy?.mode === "enforced") await changeOrgPolicySetting("sandbox", change, client);
      else await change();
      await query.refetch();
    }
    catch (error) { setError(error instanceof Error ? error.message : t("sandbox.network_save_failed")); await query.refetch(); }
    finally { setBusy(false); }
  };
  const failure = query.error;
  const invalidSettings = failure instanceof LegalworkServerError && failure.code === "execution_settings_invalid";
  const details = invalidSettings ? failure.details : undefined;
  const invalidSessionSettings = details !== null && typeof details === "object" && "settingsScope" in details && details.settingsScope === "session";
  if (state?.supported === false || state?.policy?.locked) return null;
  const items = [
    { value: "inherit", label: t("sandbox.inherit"), description: state?.source === "parent" ? t("sandbox.parent_scope") : t("sandbox.menu_inherit"), icon: RotateCcw },
    { value: "on", label: t("sandbox.on"), description: t("sandbox.menu_on"), icon: Shield },
    { value: "off", label: t("sandbox.off"), description: t("sandbox.menu_off"), icon: ShieldOff },
  ];
  const Icon = state?.enabled === false ? ShieldOff : Shield;
  const disabled = busy || !client.canApprove;
  return <div className="pointer-events-none absolute right-0 top-0 z-20 h-24 w-28">
    <div aria-hidden className="absolute inset-0 bg-dls-surface backdrop-blur-sm [mask-image:radial-gradient(ellipse_at_top_right,#000_35%,transparent_75%)]" />
    <DropdownMenu onOpenChange={open => { if (open) void query.refetch(); }}>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="pointer-events-auto absolute right-3 top-2" aria-label={t("sandbox.session_title")} title={state ? `${t("sandbox.session_title")}: ${state.enabled ? t("sandbox.on") : t("sandbox.off")}` : t("sandbox.session_title")} />}>
      <Icon size={16} aria-hidden />
    </DropdownMenuTrigger>
    <DropdownMenuContent side="bottom" align="end" className="w-88 max-w-[calc(100vw-2rem)]">
      {state ? <><DropdownMenuGroup>
        <DropdownMenuLabel>{t("sandbox.session_title")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={state.source === "session" ? state.enabled ? "on" : "off" : "inherit"} onValueChange={value => {
          if (value === "inherit") void save(null);
          else if (value === "on" || value === "off") void save({ enabled: value === "on", networkMode: state.networkMode });
        }}>
          {items.map(({ value, label, description, icon: Icon }) => <DropdownMenuRadioItem key={value} value={value} disabled={disabled} className="items-start py-3">
            <Icon className="mt-0.5 size-4" aria-hidden /><span className="min-w-0"><span className="block">{label}</span><span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">{description}</span></span>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      {state.enabled ? <><DropdownMenuSeparator /><DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={disabled}><Globe className="size-4" aria-hidden />{networkLabel(state.networkMode)}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-88 max-w-[calc(100vw-2rem)]"><SandboxNetworkItems value={state.networkMode} disabled={disabled} onChange={networkMode => { void save({ enabled: true, networkMode }); }} /></DropdownMenuSubContent>
      </DropdownMenuSub></> : null}</> : <div className="space-y-2 px-3 py-2">
        <p role="status" className="text-sm text-muted-foreground">{t(query.isError ? "sandbox.status_unavailable" : "sandbox.preparing")}</p>
        {invalidSettings && !invalidSessionSettings ? <p className="text-sm text-muted-foreground">{t("sandbox.restore_application_settings")}</p> : null}
        {invalidSessionSettings && client.canApprove ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { void save({ enabled: true, networkMode: "block" }); }}>{t("sandbox.on")} · {t("sandbox.network_block")}</Button> : null}
        <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t("sandbox.prepare")}</Button>
      </div>}
      <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">{t("sandbox.session_scope")}</p>
      {error ? <p role="alert" className="px-3 py-2 text-sm text-destructive">{error}</p> : null}
    </DropdownMenuContent>
  </DropdownMenu></div>;
}
