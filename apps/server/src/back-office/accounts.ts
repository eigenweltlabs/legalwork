import { readEigenweltConnection, type EigenweltConnection } from "../eigenwelt-connection-store.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { existingBackOfficeStore } from "./store.js";
import { backOfficePrincipalKey } from "./principal.js";
import { announceSyncChange } from "../app-sync-events.js";

function principalOf(connection: EigenweltConnection) {
  return connection.account && connection.platformURL && connection.platformToken
    ? backOfficePrincipalKey(connection.platformURL, connection.account.orgId, connection.account.userId)
    : null;
}
export async function connectedBackOfficePrincipal(config: ServerConfig) {
  return principalOf(await readEigenweltConnection(config));
}

export async function requireBackOfficePrincipal(config: ServerConfig, expected: string) {
  const connection = await readEigenweltConnection(config);
  if (principalOf(connection) !== expected)
    throw new ApiError(409, "back_office_account_changed", "The connected account changed. Refresh Back Office before continuing.");
  return connection;
}

/** No store/profile is created when Back Office has never been used. */
export async function reconcileBackOfficeAccounts(config: ServerConfig, expectedConnection: string | null, allowedScope: string | null, notify = false) {
  try {
    const store = await existingBackOfficeStore(config);
    if (!store) return;
    for (const scope of store.teamScopes())
      store.suspendAccount(scope, null, "Team access is unavailable. Reconnect as the author to review remaining drafts.", expectedConnection, scope === allowedScope ? expectedConnection : null);
  } finally {
    if (notify) announceSyncChange(config, "policy");
  }
}
