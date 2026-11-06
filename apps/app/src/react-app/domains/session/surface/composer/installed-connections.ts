import type { IntegrationSelection } from "./integration-mention";
import { connectorDefinitions, connectorIsConnected, type ConnectorStatus } from "@legalwork/types/connectors";
import type { StorageConnection } from "@legalwork/types/file-storage";
import type { LegalworkBrowserPassword } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import type { ConnectorState } from "@/react-app/domains/settings/pages/connector-status";

export type ComposerConnection = { id: string; name: string; description: string; kind: "account" | "storage" | "website"; selection: IntegrationSelection; firm?: boolean; state?: ConnectorState };

/** Match the installed catalog, keeping named storage/logins distinct from providers. */
export function installedConnections(accounts?: ConnectorStatus, storage: StorageConnection[] = [], passwords: LegalworkBrowserPassword[] = []): ComposerConnection[] {
  const items: ComposerConnection[] = [];
  for (const definition of connectorDefinitions) {
    const account = accounts?.connectors.find(item => item.id === definition.id);
    if (!account?.connections.length) continue;
    items.push({ id: `native:${definition.id}`, name: definition.name, description: t(definition.descriptionKey), kind: "account", selection: { kind: "account", id: definition.id, label: definition.name }, state: account.active === false ? "disabled" : connectorIsConnected(account) ? "connected" : "needs_auth" });
  }
  for (const connection of storage) {
    if (connection.team?.installed === false || connection.id.startsWith("connector:")) continue;
    items.push({ id: `saved-storage:${connection.id}`, name: connection.name, description: t("catalog.method_storage"), kind: "storage", selection: { kind: "storage", id: connection.id, label: connection.name }, firm: Boolean(connection.team), state: connection.enabled ? undefined : "disabled" });
  }
  for (const password of passwords) {
    if (!password.websites.length) continue;
    items.push({ id: `saved-research:${password.id}`, name: password.label, description: t("catalog.method_website_automation"), kind: "website", selection: { kind: "website", id: password.id, label: password.label } });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
