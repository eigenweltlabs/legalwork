import { createHash } from "node:crypto";
import { providerMessageKey } from "../model.js";
import { MailServiceError, type MailService } from "../service-interface.js";
import type { MailInvitationInput } from "../invitation-view.js";
import type { MailPartView } from "../read-view.js";
import { MAX_INVITATION_BYTES, parseMailInvitations } from "./parse.js";

type Reader = Pick<MailService, "status" | "readMessage" | "listParts" | "readContent" | "onLock">;

export async function readMailInvitations(mail: Reader, accountId: string, input: MailInvitationInput) {
  let locked = false;
  const unsubscribe = mail.onLock?.(() => { locked = true; });
  const ready = () => { if (locked || mail.status().state !== "ready") throw new MailServiceError("locked"); };
  const check = async () => {
    ready();
    const message = await mail.readMessage(accountId, input.locator);
    ready();
    if (message.accountId !== accountId || message.key !== providerMessageKey(input.locator) || message.removed || message.rawReferenceId !== input.rawReferenceId) throw new MailServiceError("conflict");
  };
  try {
    await check();
    let part: MailPartView | undefined, after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await mail.listParts(accountId, input.locator, { limit: 100, ...(after ? { after } : {}) });
      ready();
      part = result.items.find(value => value.kind === "attachment" && value.partId === input.partId && value.referenceId === input.referenceId);
      if (part || !result.nextCursor) break;
      if (after === result.nextCursor) throw new MailServiceError("conflict");
      after = result.nextCursor;
    }
    if (!part?.bytesAvailable || !part.sha256 || part.bytes === null) throw new MailServiceError("not_found");
    if (part.contentType?.toLowerCase() !== "text/calendar" && !part.filename?.toLowerCase().endsWith(".ics")) throw new MailServiceError("invalid_input");
    if (part.bytes > MAX_INVITATION_BYTES) throw new MailServiceError("too_large");
    const bytes = new Uint8Array(part.bytes);
    let offset = 0;
    do {
      const chunk = await mail.readContent(accountId, input.locator, { kind: "attachment", partId: input.partId, referenceId: input.referenceId, offset, limit: 24576 });
      ready();
      const data = Buffer.from(chunk.data, "base64");
      const next = offset + data.byteLength;
      if (chunk.accountId !== accountId || providerMessageKey(chunk.locator) !== providerMessageKey(input.locator) || chunk.referenceId !== input.referenceId || chunk.sha256 !== part.sha256 || chunk.totalBytes !== bytes.byteLength || chunk.offset !== offset || !data.byteLength || next > bytes.byteLength || chunk.nextOffset !== (next === bytes.byteLength ? null : next)) throw new MailServiceError("conflict");
      bytes.set(data, offset); offset = next;
    } while (offset < bytes.byteLength);
    if (input.referenceId !== `sha256:${part.sha256}` || createHash("sha256").update(bytes).digest("hex") !== part.sha256) throw new MailServiceError("conflict");
    await check();
    return parseMailInvitations(bytes);
  } finally { unsubscribe?.(); }
}
