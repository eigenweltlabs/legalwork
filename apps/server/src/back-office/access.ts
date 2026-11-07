import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { appliedOrgPolicy, readOrgPolicyState } from "../org-policy.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import type { BackOfficeActor } from "./schema.js";
import { backOfficePrincipalKey } from "./principal.js";
import { reconcileBackOfficeAccounts } from "./accounts.js";
import { backOfficeStore, existingBackOfficeStore } from "./store.js";

export async function backOfficeAccess(
  config: ServerConfig,
  team?: boolean,
): Promise<{ scope: string; actor: BackOfficeActor; sharingAllowed: boolean }> {
  const connection = await readEigenweltConnection(config), account = connection.account;
  const active = Boolean(account && await readOrgPolicyState(config) === "active");
  const policy = active ? await appliedOrgPolicy(config, "backOffice.sync") : null;
  const allowed = Boolean(policy?.locked && policy.value.enabled);
  const principalKey = account && connection.platformURL && connection.platformToken
    ? backOfficePrincipalKey(connection.platformURL, account.orgId, account.userId) : null;
  await reconcileBackOfficeAccounts(config, principalKey, allowed && account ? account.orgId : null);
  if (team === undefined) team = allowed;
  let actor: BackOfficeActor | null = null;
  if (account && principalKey && policy?.locked && policy.value.enabled) {
    const value = policy.value, admin = account.orgRole === "org:admin";
    actor = {
      userId: account.userId, principalKey,
      model: admin || value.modelEditors.includes(account.userId),
      edit: admin || value.directoryEditors.includes(account.userId),
      finance: value.billingMembers.includes(account.userId),
    };
    const store = team ? await backOfficeStore(config) : await existingBackOfficeStore(config);
    if (store) {
      store.bindAccount(account.orgId, actor);
      store.restrictTeamAccess(account.orgId, actor);
    }
  }
  if (!team)
    return { scope: "local", actor: { userId: "local", model: true, edit: true, finance: true }, sharingAllowed: false };
  if (!account || !active || !principalKey)
    throw new ApiError(403, "back_office_firm", "Sign in to your firm to open team records.");
  if (!actor)
    throw new ApiError(403, "back_office_sync_disabled", "Your platform administrator must enable Back Office sharing first.");
  return { scope: account.orgId, actor, sharingAllowed: true };
}
