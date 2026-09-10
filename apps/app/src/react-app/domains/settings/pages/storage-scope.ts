import type { StorageConnection } from "@legalwork/types/file-storage";
import type { HubScope } from "./hub-scope-context";

export function storageConnectionsForScope(connections: StorageConnection[], scope: HubScope) {
  return connections.filter((connection) =>
    scope === "team" ? Boolean(connection.team) : !connection.team || connection.team.installed,
  );
}
