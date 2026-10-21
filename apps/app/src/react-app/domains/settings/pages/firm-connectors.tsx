/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, KeyRound, Loader2, LogIn, Plug } from "lucide-react";
import type { FirmHubItem } from "@legalwork/types/firm-hub";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { McpStatus, McpStatusMap } from "@/app/types";
import { mcpMigrationStatus } from "@/app/mcp-connect-state";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { IconTile } from "@/react-app/design-system/surface";
import { IntegrationLibraryRow } from "./integration-library";
import { FIRM_HUB_QUERY_KEY, useFirmHub } from "../../connections/firm-hub";
import { MemberKeyDialog } from "../../connections/org-policy-ui";
import { ConnectorStatus, McpMigrationRecovery, connectorStatusText, resolveConnectorState } from "./connector-status";

export const firmConnectorName = (slug: string) => slug.replace(/[-_]+/g, " ").trim().replace(/\b\w/g, letter => letter.toUpperCase());

/** Team entries join the personal rows, rather than creating a second library. */
export function FirmConnectorLibrary(props: { client: LegalworkServerClient; children: (items: FirmHubItem[]) => ReactNode }) {
  const firmHub = useFirmHub(props.client);
  return <>
    {firmHub.isLoading ? <p role="status" className="text-xs text-muted-foreground">{t("firm_hub.loading")}</p> : null}
    {firmHub.error ? <p role="alert" className="text-sm text-destructive">{firmHub.error.message}</p> : null}
    {props.children((firmHub.data?.items ?? []).filter(item => item.kind === "mcp"))}
  </>;
}

/** The same access rows for every team connector, without exposing firm-owned settings. */
export function FirmConnectorAccessSettings(props: {
  item: FirmHubItem;
  status: McpStatus | undefined;
  busy: boolean;
  onAddedChange: (added: boolean) => void;
  onSignIn: () => void;
  onManageKey: () => void;
  onRetryMigration?: () => Promise<unknown>;
}) {
  const { item, status } = props;
  const installed = item.installation === "automatic" || item.added;
  const connector = item.connector;
  const migration = mcpMigrationStatus(status);
  const canSignIn = connector?.access === "oauth" && connector.url && status?.status !== "connected" && !migration;
  const accountHint = connector?.access === "oauth"
    ? status?.status === "connected" ? t("storage.oauth_connected")
      : connector.url ? t("integrations.team_sign_in_hint", { name: firmConnectorName(item.name) })
        : t("integrations.team_sign_in_unavailable")
    : connector?.access === "member"
      ? t(connector.hasOwnKey ? "integrations.team_key_saved" : "integrations.team_key_hint")
      : t(connector?.access === "firm" ? "integrations.team_firm_access" : "integrations.team_no_account");

  return <div className="space-y-4" aria-busy={props.busy}>
    <div className="divide-y divide-border">
      {item.installation === "optional" ? <div className="flex items-center justify-between gap-4 pb-5">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{t("integrations.connector_enabled")}</h3>
          <p className="text-xs leading-5 text-muted-foreground">{t("integrations.team_chat_access_hint")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {props.busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" /> : null}
          <Switch checked={installed} disabled={props.busy} aria-label={t(installed ? "mcp.disable_app" : "mcp.enable_app") + " " + firmConnectorName(item.name)} onCheckedChange={props.onAddedChange} />
        </div>
      </div> : null}
      {installed && connector ? <div className={`flex flex-wrap items-center justify-between gap-4 ${item.installation === "optional" ? "pt-5" : ""}`}>
        <div className="min-w-0 flex-1 basis-48 space-y-1">
          <h3 className="text-sm font-medium">{t("integrations.connector_account_access")}</h3>
          <p className="text-xs leading-5 text-muted-foreground">{accountHint}</p>
        </div>
        {connector.access === "member" ? <Button variant={connector.hasOwnKey ? "outline" : "default"} size="sm" disabled={props.busy} onClick={props.onManageKey}>{props.busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}{t(connector.hasOwnKey ? "firm_hub.change_key" : "firm_hub.add_key")}</Button> : null}
        {canSignIn ? <Button size="sm" disabled={props.busy} onClick={props.onSignIn}>{props.busy ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}{t("firm_hub.sign_in")}</Button> : null}
      </div> : null}
    </div>
    {installed && migration ? <McpMigrationRecovery migration={migration} message={status && "error" in status ? status.error : status && "message" in status ? status.message ?? null : null} busy={props.busy} onRetry={props.onRetryMigration} onReconnect={props.onSignIn} /> : null}
    {installed && !migration && (status?.status === "failed" || status?.status === "needs_client_registration") ? <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{connectorStatusText(status.status)}</AlertTitle>
      <AlertDescription><p>{t("integrations.team_connection_help")}</p>{status.error ? <p className="break-words">{status.error}</p> : null}</AlertDescription>
    </Alert> : null}
  </div>;
}

/** Team-owned config stays managed by the hub; only optional membership and the member's account can change here. */
export function FirmConnectorRow(props: { item: FirmHubItem; client: LegalworkServerClient; statuses: McpStatusMap; busy: boolean; onSignIn: (name: string, url: string) => void; onChanged?: () => void; onRetryMigration?: (name: string) => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { item } = props;
  const name = firmConnectorName(item.name);
  const installed = item.installation === "automatic" || item.added;
  const connector = item.connector;
  const status = connector ? props.statuses[connector.serverName]?.status : undefined;
  const migration = mcpMigrationStatus(connector ? props.statuses[connector.serverName] : undefined);
  const needsKey = installed && connector?.access === "member" && !connector.hasOwnKey;
  const needsSignIn = installed && connector?.access === "oauth" && status !== "connected";
  const canSignIn = needsSignIn && connector?.url && (!migration || migration.state === "blocked" && migration.canReconnect);
  const state = resolveConnectorState({ enabled: installed, status, needsKey, needsSignIn });

  function signIn() {
    if (canSignIn && connector?.url) return props.onSignIn(connector.serverName, connector.url);
  }

  async function setAdded(added: boolean) {
    setBusy(true);
    try {
      queryClient.setQueryData(FIRM_HUB_QUERY_KEY, await props.client.setFirmHubAdded(item.id, added));
      props.onChanged?.();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("firm_hub.add_failed"));
    } finally { setBusy(false); }
  }

  async function saveKey(key: string) {
    queryClient.setQueryData(FIRM_HUB_QUERY_KEY, await props.client.setFirmHubKey(item.id, key));
    toast.success(t("firm_hub.key_saved", { name }));
    props.onChanged?.();
  }

  return <>
    <IntegrationLibraryRow name={name} description={item.description} icon={<span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border"><Plug className="size-4 text-muted-foreground" /></span>} source={t("firm_hub.scope_team")} status={<ConnectorStatus state={state} />} busy={props.busy || busy} onOpen={() => setDetailsOpen(true)}
      actions={canSignIn ? <DropdownMenuItem disabled={props.busy || busy} onClick={signIn}><LogIn />{t("firm_hub.sign_in")}</DropdownMenuItem> : undefined} />
    <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto bg-background">
        <DialogHeader className="pe-6">
          <div className="mb-1 flex items-center gap-3"><IconTile size="sm"><Plug /></IconTile><DialogTitle>{name}</DialogTitle></div>
          <DialogDescription>
            {item.description ? <span className="mb-1 block">{item.description}</span> : null}
            <span className="block text-xs">{t(item.installation === "automatic" ? "integrations.team_managed" : "integrations.team_optional")}</span>
          </DialogDescription>
        </DialogHeader>
        <FirmConnectorAccessSettings item={item} status={connector ? props.statuses[connector.serverName] : undefined} busy={props.busy || busy}
          onRetryMigration={connector && props.onRetryMigration ? () => props.onRetryMigration!(connector.serverName) : undefined}
          onAddedChange={added => { if (added) setConfirmAdd(true); else void setAdded(false); }} onSignIn={signIn} onManageKey={() => setKeyOpen(true)} />
      </DialogContent>
    </Dialog>
    {keyOpen ? <MemberKeyDialog name={name} onSave={saveKey} onClose={() => setKeyOpen(false)} /> : null}
    <ConfirmModal open={confirmAdd} title={t("firm_hub.add_review_title", { name })} message={t("integrations.team_add_review")} confirmLabel={t("firm_hub.add")} cancelLabel={t("common.cancel")} variant="warning" onCancel={() => setConfirmAdd(false)} onConfirm={() => { setConfirmAdd(false); void setAdded(true); }} />
  </>;
}
