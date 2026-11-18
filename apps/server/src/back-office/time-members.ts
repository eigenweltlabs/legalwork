import { ApiError } from "../errors.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { intakeListMembers, requireIntakeClient } from "../eigenwelt-intake.js";
import { requireBackOfficePrincipal } from "./accounts.js";
import { taskStore } from "../task-store.js";
import type { ServerConfig } from "../types.js";
import type { BackOfficeActor, BackOfficeValue } from "./schema.js";
import type { BackOfficeStore } from "./store.js";
import { memberSource, timeMemberContactId } from "./time-member-identity.js";

/** Reuse the platform's organization roster. Reading it never creates contacts. */
export async function timeMembers(config: ServerConfig, scope: string, actor: BackOfficeActor) {
  if (scope === "local") return [{ userId: actor.userId, name: "Local user", email: null }];
  if (!actor.principalKey) throw new ApiError(403, "time_member_account", "Sign in to your firm.");
  await ensureFreshPlatformToken(config);
  const connection = await requireBackOfficePrincipal(config, actor.principalKey);
  if (connection.account?.orgId !== scope) throw new ApiError(409, "time_member_account", "The firm changed.");
  const members = await intakeListMembers(requireIntakeClient(connection));
  await requireBackOfficePrincipal(config, actor.principalKey);
  (await taskStore(config)).replaceMembers(scope, members);
  // The authenticated account is authoritative even if the roster omits self.
  if (!members.some(member => member.userId === actor.userId)) members.unshift({
    userId: actor.userId, name: connection.account.userName, email: connection.account.userEmail, role: connection.account.orgRole ?? "org:member",
  });
  return members;
}

/** A member is represented by an ordinary synced contact, linked by its external
 * source identity (not a name/email guess). Entry authorship remains unchanged. */
export function timeMemberContact(store: BackOfficeStore, scope: string, actor: BackOfficeActor,
  member: { userId: string; name: string | null; email: string | null }) {
  const object = store.model(scope).objects.find(object => object.id === "people" && !object.archived);
  if (!object) throw new ApiError(409, "time_member_model", "The firm has no people directory.");
  const sourceId = memberSource(member.userId);
  const id = timeMemberContactId(scope, member.userId);
  const existing = store.raw(scope, id);
  if (existing) {
    if (existing.objectId === "people" && existing.sourceId === sourceId && !existing.archivedAt &&
      existing.values.active !== false && store.canRead(scope, existing, actor)) return id;
    throw new ApiError(409, "time_member_contact", "The firm member's contact is unavailable. Check it in People.");
  }
  const values: Record<string, BackOfficeValue> = { name: member.name || member.email || member.userId };
  if (object.fields.some(field => field.id === "email")) values.email = member.email;
  if (object.fields.some(field => field.id === "active")) values.active = true;
  if (object.fields.some(field => field.id === "personType" && field.options.includes("Other team member"))) values.personType = "Other team member";
  return store.saveRecord(scope, actor, { id, create: true, revision: 0, objectId: "people", sourceId, values }, member.userId).id;
}
