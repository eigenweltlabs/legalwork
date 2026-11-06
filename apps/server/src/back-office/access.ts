import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { appliedOrgPolicy, readOrgPolicyState } from "../org-policy.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import type { BackOfficeActor } from "./schema.js";

export async function backOfficeAccess(
  config: ServerConfig,
  team: boolean,
): Promise<{ scope: string; actor: BackOfficeActor; sharingAllowed: boolean }> {
  const account = (await readEigenweltConnection(config))?.account;
  if (!team)
    return {
      scope: "local",
      actor: { userId: "local", model: true, edit: true, finance: true },
      sharingAllowed: false,
    };
  if (!account || (await readOrgPolicyState(config)) !== "active")
    throw new ApiError(
      403,
      "back_office_firm",
      "Sign in to your firm to open team records.",
    );
  const policy = await appliedOrgPolicy(config, "backOffice.sync");
  if (!policy?.locked || !policy.value.enabled)
    throw new ApiError(
      403,
      "back_office_sync_disabled",
      "Your platform administrator must enable Back Office sharing first.",
    );
  const value = policy.value,
    admin = account.orgRole === "org:admin";
  return {
    scope: account.orgId,
    sharingAllowed: true,
    actor: {
      userId: account.userId,
      model: admin || value.modelEditors.includes(account.userId),
      edit: admin || value.directoryEditors.includes(account.userId),
      finance: value.billingMembers.includes(account.userId),
    },
  };
}
