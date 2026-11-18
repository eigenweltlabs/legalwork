import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { intakeListMembers, requireIntakeClient } from "../eigenwelt-intake.js";
import { requireBackOfficePrincipal } from "./accounts.js";
import { taskStore } from "../task-store.js";
import type { ServerConfig } from "../types.js";
import type { BackOfficeActor, BackOfficeValue } from "./schema.js";
import type { BackOfficeStore } from "./store.js";

const prefix = "eigenwelt-member:";
export const memberSource = (userId: string) => prefix + userId;

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
  const sourceId = memberSource(member.userId);
  const existing = store.records(scope, actor, "people").find(record => record.sourceId === sourceId);
  if (existing) return existing.id;
  const hex = createHash("sha256").update(JSON.stringify([scope, sourceId])).digest("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const object = store.model(scope).objects.find(object => object.id === "people" && !object.archived);
  if (!object) throw new ApiError(409, "time_member_model", "The firm has no people directory.");
  const values: Record<string, BackOfficeValue> = { name: member.name || member.email || member.userId };
  if (object.fields.some(field => field.id === "email")) values.email = member.email;
  if (object.fields.some(field => field.id === "active")) values.active = true;
  if (object.fields.some(field => field.id === "personType" && field.options.includes("Other team member"))) values.personType = "Other team member";
  return store.saveRecord(scope, actor, { id, create: true, revision: 0, objectId: "people", sourceId, values }).id;
}
