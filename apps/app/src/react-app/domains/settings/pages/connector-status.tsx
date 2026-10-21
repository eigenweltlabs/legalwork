import { useState } from "react";
import type { McpMigrationStatus, McpServerEntry, McpStatus } from "@/app/types";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { connectorNeedsSetup } from "@/app/mcp-configuration";

export type ConnectorState = McpStatus["status"] | "disconnected" | "needs_key" | "needs_setup";

/** Ownership changes available controls, not the meaning of a connection state. */
export function resolveConnectorState(input: {
  status?: McpStatus["status"] | "disconnected";
  enabled: boolean;
  needsKey?: boolean;
  needsSignIn?: boolean;
}): ConnectorState {
  if (!input.enabled || input.status === "disabled") return "disabled";
  if (input.needsKey) return "needs_key";
  if (input.status === "connecting" || input.status === "connected" || input.status === "failed" || input.status === "needs_client_registration") return input.status;
  if (input.status === "needs_auth" || input.needsSignIn) return "needs_auth";
  return input.status ?? "disconnected";
}

export function configuredConnectorState(entry: McpServerEntry, status?: McpStatus): ConnectorState {
  if (connectorNeedsSetup(entry.config)) return "needs_setup";
  return resolveConnectorState({ enabled: entry.config.enabled !== false, status: status?.status });
}

const messages = {
  connected: null,
  connecting: "mcp.connecting",
  disabled: "integrations.connector_needs_enable",
  needs_auth: "firm_hub.connector_needs_sign_in",
  needs_key: "firm_hub.connector_needs_key",
  needs_setup: "connector_setup.required_status",
  needs_client_registration: "integrations.team_sign_in_setup",
  failed: "mcp.friendly_status_issue",
  disconnected: "mcp.friendly_status_offline",
} satisfies Record<ConnectorState, string | null>;

const dots = {
  connected: null,
  connecting: "bg-blue-9 animate-pulse",
  disabled: null,
  needs_auth: "bg-amber-9",
  needs_key: "bg-amber-9",
  needs_setup: "bg-amber-9",
  needs_client_registration: "bg-amber-9",
  failed: "bg-red-9",
  disconnected: "bg-gray-7",
} satisfies Record<ConnectorState, string | null>;

export function connectorStatusText(state: ConnectorState) {
  const key = messages[state];
  return key ? t(key) : null;
}

export function ConnectorStatus({ state }: { state: ConnectorState }) {
  const label = connectorStatusText(state);
  if (!label) return null;
  const dot = dots[state];
  return <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
    {dot ? <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} /> : null}
    {label}
  </span>;
}

export function McpMigrationRecovery(props: {
  migration: McpMigrationStatus; message: string | null; busy: boolean;
  onRetry?: () => Promise<unknown>; onReconnect: () => void | Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const act = async (operation: () => unknown) => {
    setWorking(true);
    try { await operation(); } finally { setWorking(false); }
  };
  const blocked = props.migration.state === "blocked";
  return <div role={blocked ? "alert" : "status"} className="space-y-3 rounded-lg border border-border p-3 text-xs leading-5">
    <p className="font-medium">{t(blocked ? "mcp.migration_blocked" : "mcp.migration_waiting")}</p>
    <p className="text-muted-foreground">{props.message}</p>
    {blocked ? <div className="flex flex-wrap gap-2">
      {props.onRetry ? <Button variant="outline" size="sm" disabled={props.busy || working} onClick={() => void act(() => props.onRetry?.())}>{t("mcp.migration_retry")}</Button> : null}
      {props.migration.canReconnect ? <Button size="sm" disabled={props.busy || working} onClick={() => void act(props.onReconnect)}>{t("mcp.migration_reconnect")}</Button> : null}
    </div> : null}
  </div>;
}

/** A plugin can have usable skills alongside connectors that still need setup. */
export function PluginConnectorStatus({ states }: { states: readonly (ConnectorState | undefined)[] }) {
  const pending = states.filter((state): state is ConnectorState => state !== undefined && state !== "connected");
  if (!pending.length) return null;
  const needsAttention = pending.some(state => state === "failed" || state === "disconnected");
  const dot = pending.includes("failed") ? "bg-red-9" : pending.some(state => state !== "disconnected") ? "bg-amber-9" : "bg-gray-7";
  return <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
    <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
    {t(needsAttention ? "plugin_details.connectors_need_attention" : "plugin_details.connectors_need_setup", { count: pending.length })}
  </span>;
}
