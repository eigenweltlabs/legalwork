import { createHash } from "node:crypto";
import type { BackOfficeRecord } from "./schema.js";

const prefix = "eigenwelt-member:";
export const memberSource = (userId: string) => prefix + userId;
export const isTimeMemberSource = (sourceId: string | null | undefined) => sourceId?.startsWith(prefix) ?? false;

export function timeMemberContactId(scope: string, userId: string) {
  const hex = createHash("sha256").update(JSON.stringify([scope, memberSource(userId)])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function timeMemberUserId(scope: string, contact: BackOfficeRecord | null) {
  if (contact?.objectId !== "people" || !contact.sourceId?.startsWith(prefix)) return undefined;
  const userId = contact.sourceId.slice(prefix.length);
  if (userId && userId.length <= 200 && contact.id === timeMemberContactId(scope, userId)) return userId;
}
