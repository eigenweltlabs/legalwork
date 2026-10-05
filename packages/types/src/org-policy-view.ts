import type { OrgPolicyEntry, OrgPolicyKey } from "./org-policy.js";

/**
 * The firm's policy as it applies on this computer, as a LegalWork server
 * shows it to its app (GET /workspace/:id/org-policy). Not part of the
 * platform contract.
 * - `active`: signed in to the firm; enforced settings are `locked`.
 * - `lapsed`: signed out; everything still applies, and each setting can be
 *   taken back (`released`) after the member confirmed.
 */
export type OrgPolicyState = "none" | "active" | "lapsed";

export type OrgPolicyViewEntry<K extends OrgPolicyKey> = OrgPolicyEntry<K> & { locked: boolean; released: boolean };

export type OrgPolicyView = {
  state: OrgPolicyState;
  orgId: string | null;
  orgName: string | null;
  /** The member's role in the firm, while signed in to it. */
  role: "admin" | "member" | null;
  revision: number;
  platformURL: string | null;
  entries: { [K in OrgPolicyKey]?: OrgPolicyViewEntry<K> };
  /** The last time signing in put enforced settings back, for the app to say so once. */
  restored: { at: number; count: number } | null;
};
