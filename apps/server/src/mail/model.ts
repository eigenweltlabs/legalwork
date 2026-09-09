import { z } from "zod";

const opaqueId = z.string().min(1).max(4096);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Provider identity is independent of RFC Message-ID, MIME hashes and threads. */
export const providerMessageLocatorSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("gmail"), messageId: opaqueId }).strict(),
  z.object({ provider: z.literal("graph"), messageId: opaqueId }).strict(),
  z.object({
    provider: z.literal("imap"),
    mailboxId: opaqueId,
    uidValidity: z.number().int().min(1).max(0xffffffff),
    uid: z.number().int().min(1).max(0xffffffff),
  }).strict(),
]);

export type ProviderMessageLocator = z.infer<typeof providerMessageLocatorSchema>;

/** Canonical arrays avoid delimiter collisions; callers must still scope by account. */
export function providerMessageKey(input: ProviderMessageLocator): string {
  const locator = providerMessageLocatorSchema.parse(input);
  return locator.provider === "imap"
    ? JSON.stringify(["imap", locator.mailboxId, locator.uidValidity, locator.uid])
    : JSON.stringify([locator.provider, locator.messageId]);
}

export function accountMessageKey(accountId: string, locator: ProviderMessageLocator): string {
  return JSON.stringify([opaqueId.parse(accountId), providerMessageKey(locator)]);
}

export const mailDownloadProgressSchema = z.object({
  enumerationComplete: z.boolean(),
  messagesDiscovered: count,
  metadataStored: count,
  rawMessagesStored: count,
  bodiesStored: count,
  attachmentsDiscovered: count,
  attachmentsStored: count,
  /** Originals that the provider cannot return; not silently counted as downloaded. */
  unavailableMessages: count,
  unavailableAttachments: count,
  /** Includes queued and running jobs; completion is recorded only after durable content. */
  outstandingJobs: count,
  failedJobs: count,
  excludedScopes: z.array(z.object({
    scopeId: opaqueId,
    reason: z.enum(["user-excluded", "provider-unavailable", "protected-content"]),
  }).strict()),
}).strict().superRefine((value, ctx) => {
  const checks: [boolean, string, string][] = [
    [value.metadataStored <= value.messagesDiscovered, "metadataStored", "Metadata cannot exceed discovered messages"],
    [value.rawMessagesStored <= value.metadataStored, "rawMessagesStored", "Raw content requires stored metadata"],
    [value.bodiesStored <= value.metadataStored, "bodiesStored", "Bodies require stored metadata"],
    [value.unavailableMessages + value.rawMessagesStored <= value.messagesDiscovered, "unavailableMessages", "Unavailable originals cannot also count as stored"],
    [value.attachmentsStored + value.unavailableAttachments <= value.attachmentsDiscovered, "attachmentsStored", "Attachment totals exceed discovery"],
  ];
  for (const [valid, field, message] of checks) {
    if (!valid) ctx.addIssue({ code: "custom", path: [field], message });
  }
});

export type MailDownloadProgress = z.infer<typeof mailDownloadProgressSchema>;
export type MailDownloadState = "discovering" | "downloading" | "attention" | "complete";

/** A download snapshot never derives content completeness from search-index status. */
export function mailDownloadState(input: MailDownloadProgress): MailDownloadState {
  const progress = mailDownloadProgressSchema.parse(input);
  if (progress.failedJobs > 0 || progress.unavailableMessages > 0 ||
      progress.unavailableAttachments > 0 || progress.excludedScopes.length > 0) return "attention";
  if (!progress.enumerationComplete) return "discovering";
  const complete = progress.metadataStored === progress.messagesDiscovered &&
    progress.rawMessagesStored === progress.messagesDiscovered &&
    progress.bodiesStored === progress.messagesDiscovered &&
    progress.attachmentsStored === progress.attachmentsDiscovered &&
    progress.outstandingJobs === 0;
  return complete ? "complete" : "downloading";
}
