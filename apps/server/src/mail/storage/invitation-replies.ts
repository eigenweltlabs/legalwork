import type { MailDatabase } from "./database-interface.js";
import { MailLocalError } from "./local-api.js";
import { invitationReplyJournalInputSchema, invitationReplyJournalEntrySchema, type InvitationReplyJournalInput, type InvitationReplyJournalResult } from "../invitation-reply-view.js";

// Owner-wide target hashes keep the same calendar event fenced across messages,
// mail accounts and restarts. No provider credentials or event content are stored.
export class MailInvitationRepliesStore {
  constructor(private readonly database: MailDatabase, private readonly ownerId: string) {}
  execute(accountId: string, input: InvitationReplyJournalInput): InvitationReplyJournalResult {
    const command = invitationReplyJournalInputSchema.parse(input);
    if (!this.database.get("SELECT id FROM mail_accounts WHERE id=? AND owner_id=?", [accountId, this.ownerId])) throw new MailLocalError("not_found");
    return this.database.transaction(() => {
      const row = this.database.get("SELECT event_key AS key,attempt_id AS attemptId,response,state,updated_at AS updatedAt FROM mail_invitation_replies WHERE owner_id=? AND event_key=?", [this.ownerId, command.key]);
      const current = row ? invitationReplyJournalEntrySchema.parse(row) : null;
      if (command.action === "read") return { accountId, entry: current, claimed: false };
      if (command.action === "begin") {
        if (current?.state === "uncertain") return { accountId, entry: current, claimed: false };
        // Reusing an attempt ID can never become a new dispatch, even after success.
        if (current?.attemptId === command.attemptId) return { accountId, entry: current, claimed: false };
        const entry = { key: command.key, attemptId: command.attemptId, response: command.response, state: "uncertain", updatedAt: Date.now() } satisfies NonNullable<InvitationReplyJournalResult["entry"]>;
        this.database.run("INSERT INTO mail_invitation_replies(owner_id,event_key,attempt_id,response,state,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,event_key) DO UPDATE SET attempt_id=excluded.attempt_id,response=excluded.response,state=excluded.state,updated_at=excluded.updated_at", [this.ownerId, entry.key, entry.attemptId, entry.response, entry.state, entry.updatedAt]);
        return { accountId, entry, claimed: true };
      }
      if (!current || current.attemptId !== command.attemptId) throw new MailLocalError("conflict");
      if (current.state !== "uncertain" && current.state !== command.state) throw new MailLocalError("conflict");
      const entry = { ...current, state: command.state, updatedAt: Date.now() };
      this.database.run("UPDATE mail_invitation_replies SET state=?,updated_at=? WHERE owner_id=? AND event_key=? AND attempt_id=?", [entry.state, entry.updatedAt, this.ownerId, entry.key, entry.attemptId]);
      return { accountId, entry, claimed: false };
    });
  }
}
