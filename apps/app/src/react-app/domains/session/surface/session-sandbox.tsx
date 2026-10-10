import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, RotateCcw, Shield, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SandboxNetworkItems, networkLabel } from "../../settings/panels/sandbox-network-control";
import { changeOrgPolicySetting } from "../../connections/org-policy";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function SessionSandbox({ client, workspaceId, sessionId }: { client: LegalworkServerClient; workspaceId: string; sessionId: string }) {
  const query = useQuery({ queryKey: ["session-sandbox", client.baseUrl, workspaceId, sessionId], queryFn: () => client.sessionSandbox(workspaceId, sessionId), refetchInterval: 5000 });
  const state = query.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state?.supported || state.policy?.locked) return null;
  const save = async (settings: { enabled: boolean; networkMode: "allow" | "block" | "approve" } | null) => {
    setBusy(true); setError(null);
    try {
      const change = () => client.setSessionSandbox(workspaceId, sessionId, settings).then(() => undefined);
      if (state.policy?.mode === "enforced") await changeOrgPolicySetting("sandbox", change, client);
      else await change();
      await query.refetch();
    }
    catch (error) { setError(error instanceof Error ? error.message : t("sandbox.network_save_failed")); await query.refetch(); }
    finally { setBusy(false); }
  };
  const items = [
    { value: "inherit", label: t("sandbox.inherit"), description: state.source === "parent" ? t("sandbox.parent_scope") : t("sandbox.menu_inherit"), icon: RotateCcw },
    { value: "on", label: t("sandbox.on"), description: t("sandbox.menu_on"), icon: Shield },
    { value: "off", label: t("sandbox.off"), description: t("sandbox.menu_off"), icon: ShieldOff },
  ];
  const Icon = state.enabled ? Shield : ShieldOff;
  const disabled = busy || !client.canApprove;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="titlebar-no-drag" aria-label={t("sandbox.session_title")} title={`${t("sandbox.session_title")}: ${state.enabled ? t("sandbox.on") : t("sandbox.off")}`} />}>
      <Icon size={16} aria-hidden />
    </DropdownMenuTrigger>
    <DropdownMenuContent side="bottom" align="end" className="w-88 max-w-[calc(100vw-2rem)]">
      <DropdownMenuGroup>
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
      </DropdownMenuSub></> : null}
      <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">{t("sandbox.session_scope")}</p>
      {error ? <p role="alert" className="px-3 py-2 text-sm text-destructive">{error}</p> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}
