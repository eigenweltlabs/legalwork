import { Gauge, LogIn, Settings, UserRound } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { isEigenweltEntitledStatus } from "@/app/lib/eigenwelt-trial";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useEigenweltEntitlements } from "../../connections/eigenwelt-entitlements";
import { workspaceSettingsRoute } from "../../../shell/workspace-routes";

export function EigenweltAccountMenu({ client, workspaceId }: {
  client: LegalworkServerClient | null;
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const query = useEigenweltEntitlements({ client, workspaceId });
  const { account, entitlements, connected } = query.data ?? {};
  const name = connected ? account?.userName?.trim() || account?.userEmail || t("account.connected_title") : t("account.connected_title");
  const initials = connected && (account?.userName || account?.userEmail)
    ? (account.userName?.trim() || account.userEmail || "").split(/[\s@]+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join("").toLocaleUpperCase()
    : null;
  const status = query.isError ? t("account.status_unavailable") : !query.data ? t("firm_hub.loading") : connected ? t("account.signed_in") : t("account.signed_out");
  const plan = connected && entitlements?.plan && isEigenweltEntitledStatus(entitlements.subscriptionStatus)
    ? entitlements.plan.charAt(0).toUpperCase() + entitlements.plan.slice(1)
    : null;
  const usage = connected ? entitlements?.usage : null;
  const remaining = usage && usage.allowanceCents > 0 && Number.isFinite(usage.usedPercent)
    ? Math.round(Math.max(0, Math.min(100, 100 - usage.usedPercent))) : null;
  const resetAt = usage?.resetsAt ? Date.parse(usage.resetsAt) : NaN;
  const resetLabel = Number.isFinite(resetAt)
    ? new Intl.DateTimeFormat(currentLocale(), { weekday: "short", day: "numeric", month: "short" }).format(resetAt) : null;
  const openSettings = (tab: string) => navigate(workspaceId ? workspaceSettingsRoute(workspaceId, tab) : `/settings/${tab}`, { state: location.state });
  const avatar = (large = false) => (
    <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center rounded-full font-medium", large ? "size-10 text-sm" : "size-8 text-[11px]", connected ? "bg-amber-5 text-amber-12" : "bg-muted text-muted-foreground")}>
      {initials || <UserRound className={large ? "size-5" : "size-4"} />}
    </span>
  );

  return (
    <DropdownMenu onOpenChange={open => { if (open && client && workspaceId) void query.refetch(); }}>
      <Tooltip>
        <DropdownMenuTrigger render={<TooltipTrigger render={
          <Button variant="ghost" size="icon" className="relative size-10 rounded-xl hover:bg-foreground/10 data-[popup-open]:bg-foreground/10" aria-label={`${name} · ${status}`}>
            {avatar()}
            <span aria-hidden="true" className={cn("absolute bottom-1 right-1 size-2 rounded-full border-2 border-[var(--lw-window-chrome)]", query.isError ? "bg-amber-9" : connected ? "bg-green-9" : "bg-muted-foreground/50")} />
          </Button>
        } />} />
        <TooltipContent side="right" sideOffset={10}>{name} · {status}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="end" sideOffset={12} className="w-80 max-w-[calc(100vw-1.5rem)] p-2">
        <DropdownMenuItem className="items-center gap-3 px-3 py-3" onClick={() => openSettings("account")}>
          {avatar(true)}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{plan ? `${plan} · ${status}` : status}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {connected ? (
          <DropdownMenuItem className="items-start gap-3 py-3" onClick={() => openSettings("account")}>
            <Gauge className="mt-0.5 size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-4">
                <span>{t(usage?.window === "day" ? "firm_hub.usage_label" : "firm_hub.usage_label_week")}</span>
                <span className="text-xs font-normal tabular-nums text-muted-foreground">{remaining === null ? t("account.usage_unavailable") : t("account.usage_left", { percent: String(remaining) })}</span>
              </span>
              {remaining !== null && <span className="mt-2 block h-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-foreground/70" style={{ width: `${remaining}%` }} /></span>}
              {resetLabel && <span className="mt-1.5 block text-[11px] font-normal text-muted-foreground">{t("firm_hub.usage_resets", { date: resetLabel })}</span>}
            </span>
          </DropdownMenuItem>
        ) : <DropdownMenuItem onClick={() => openSettings("account")}><LogIn />{t("account.sign_in")}</DropdownMenuItem>}
        <DropdownMenuItem onClick={() => openSettings("general")}><Settings />{t("settings.tab_settings")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
