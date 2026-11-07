import { createHash } from "node:crypto";
import { canonicalBackOfficeAudit, type BackOfficeActor } from "./schema.js";

export function backOfficePrincipalKey(platformURL: string, orgId: string, userId: string) {
  const url = new URL(platformURL);
  url.hash = "";
  url.search = "";
  return createHash("sha256").update(canonicalBackOfficeAudit({
    platform: url.href.replace(/\/+$/, ""), orgId, userId,
  })).digest("hex");
}

export const backOfficeAuthorKey = (actor: BackOfficeActor) =>
  actor.principalKey ?? `user:${actor.userId}`;

export function backOfficeDirectoryKey(platformURL: string, orgId: string) {
  const url = new URL(platformURL); url.hash = ""; url.search = "";
  return `team:${createHash("sha256").update(canonicalBackOfficeAudit({ platform: url.href.replace(/\/+$/, ""), orgId })).digest("hex")}`;
}
