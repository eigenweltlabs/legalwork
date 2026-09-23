import { z } from "zod";
import {
  CONTACT_SCOPES,
  contactsResultSchema,
  type ContactsInput,
  type ContactsResult,
} from "../contacts-view.js";
import { MailServiceError } from "../service-interface.js";
import { MailCredentialRepository } from "../storage/credentials.js";
import { GraphMailboxRepository } from "../storage/graph-mailboxes.js";
import type { MailDatabase } from "../storage/database-interface.js";
import type { MailAccessCoordinator } from "../providers/access-coordinator.js";
import { ContactsError, fetchContactSnapshot } from "../providers/contacts.js";
import { mailAddressSchema } from "../local-view.js";
const bookSchema = z.object({
  cursor: z.string().nullable(),
  last_sync_at: z.number().nullable(),
  attempt_at: z.number(),
  error: contactsResultSchema.shape.error,
});
/** Worker-owned read-only mirror. A whole delta round is published atomically with
 * its cursor; failures retain the previous offline snapshot. Provider IDs remain
 * distinct; matching email addresses are deduplicated only when suggesting. */
export class MailContacts {
  private pending = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private paused = false;
  private closed = false;
  private readonly credentials: MailCredentialRepository;
  constructor(
    private readonly db: MailDatabase,
    private readonly owner: string,
    private readonly access: Pick<MailAccessCoordinator, "acquire">,
    private readonly fetchSnapshot = fetchContactSnapshot,
  ) {
    this.credentials = new MailCredentialRepository(db, owner);
  }
  private account(accountId: string) {
    const row = this.db.get(
      "SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?",
      [accountId, this.owner],
    );
    if (!row) throw new MailServiceError("not_found");
    const status = this.credentials.status(accountId);
    if (
      status.state === "disconnected" ||
      (status.state === "connected" && status.archiveLocked)
    )
      throw new MailServiceError("locked");
    return row.provider === "gmail"
      ? "gmail"
      : row.provider === "graph" &&
          !new GraphMailboxRepository(this.db, this.owner).read(accountId)
        ? "graph"
        : null;
  }
  execute(accountId: string, input: ContactsInput): ContactsResult {
    const provider = this.account(accountId);
    if (!provider)
      return {
        accountId,
        enabled: false,
        state: "unsupported",
        count: 0,
        lastSyncAt: null,
        error: null,
        items: [],
      };
    if (input.action === "disable") {
      this.pending.get(accountId)?.controller.abort();
      this.db.run("DELETE FROM mail_contact_books WHERE account_id=?", [
        accountId,
      ]);
    }
    if (input.action === "sync") {
      if (this.paused || this.closed) throw new MailServiceError("locked");
      this.db.run(
        "INSERT INTO mail_contact_books(account_id) VALUES(?) ON CONFLICT DO NOTHING",
        [accountId],
      );
      this.start(accountId);
    }
    const raw = this.db.get(
      "SELECT cursor,last_sync_at,attempt_at,error FROM mail_contact_books WHERE account_id=?",
      [accountId],
    );
    const book = raw ? bookSchema.parse(raw) : null;
    const count = this.db.get(
      "SELECT count(*) AS n FROM mail_contact_entries WHERE account_id=?",
      [accountId],
    )?.n;
    const items: ContactsResult["items"] = [];
    if (book && input.action === "search") {
      const query = input.query.trim().toLocaleLowerCase();
      const seen = new Set<string>();
      // Hard cache cap bounds offline scanning; all names/addresses remain encrypted.
      for (const row of this.db.all(
        "SELECT name,addresses_json FROM mail_contact_entries WHERE account_id=? ORDER BY name,provider_id",
        [accountId],
      )) {
        const name = z.string().max(256).parse(row.name),
          addresses = z
            .array(mailAddressSchema)
            .max(100)
            .parse(JSON.parse(z.string().parse(row.addresses_json)));
        for (const address of addresses) {
          const key = address.toLocaleLowerCase();
          if (
            seen.has(key) ||
            (!name.toLocaleLowerCase().includes(query) && !key.includes(query))
          )
            continue;
          seen.add(key);
          items.push({ address, name, source: "personal" });
          if (items.length === 30) break;
        }
        if (items.length === 30) break;
      }
    }
    return {
      accountId,
      enabled: !!book,
      state: !book
        ? "disabled"
        : this.pending.has(accountId)
          ? "syncing"
          : book.error
            ? "error"
            : "ready",
      count: typeof count === "number" ? count : 0,
      lastSyncAt: book?.last_sync_at ?? null,
      error: book?.error ?? null,
      items,
    };
  }
  private start(accountId: string) {
    if (this.paused || this.closed) return;
    const prior = this.pending.get(accountId);
    if (prior) {
      if (prior.controller.signal.aborted)
        void prior.promise
          .then(() => {
            if (
              this.db.get(
                "SELECT account_id FROM mail_contact_books WHERE account_id=?",
                [accountId],
              )
            )
              this.start(accountId);
          })
          .catch(() => {});
      return;
    }
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.sync(accountId, controller.signal))
      .finally(() => this.pending.delete(accountId));
    this.pending.set(accountId, { controller, promise });
    void promise.catch(() => {});
  }
  /** Called after credentials/configuration are restored, and periodically while awake. */
  refreshDue() {
    if (this.paused || this.closed) return;
    for (const row of this.db.all(
      "SELECT b.account_id FROM mail_contact_books b JOIN mail_accounts a ON a.id=b.account_id WHERE a.owner_id=? AND b.attempt_at<?",
      [this.owner, Date.now() - 15 * 60_000],
    ))
      if (typeof row.account_id === "string") this.start(row.account_id);
  }
  private async sync(accountId: string, signal: AbortSignal) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.pending.get(accountId)?.controller.abort();
    }, 120000);
    try {
      const provider = this.account(accountId);
      if (!provider) return;
      const raw = this.db.get(
        "SELECT cursor,last_sync_at,attempt_at,error FROM mail_contact_books WHERE account_id=?",
        [accountId],
      );
      if (!raw) return;
      const book = bookSchema.parse(raw);
      this.db.run(
        "UPDATE mail_contact_books SET attempt_at=? WHERE account_id=?",
        [Date.now(), accountId],
      );
      const access = await this.access.acquire(accountId);
      signal.throwIfAborted();
      const scopes = access.grantedScopes?.map((scope) =>
        provider === "graph"
          ? scope.replace(/^https:\/\/graph.microsoft.com\//, "")
          : scope,
      );
      if (!scopes?.includes(CONTACT_SCOPES[provider]))
        throw new ContactsError("permission");
      const snapshot = await this.fetchSnapshot({
        provider,
        accessToken: access.accessToken,
        cursor: book.cursor,
        signal,
      });
      signal.throwIfAborted();
      const current = this.credentials.status(accountId);
      if (
        current.state !== "connected" ||
        current.archiveLocked ||
        current.version.generation !== access.version.generation
      )
        throw new MailServiceError("locked");
      this.db.transaction(() => {
        if (
          !this.db.get(
            "SELECT account_id FROM mail_contact_books WHERE account_id=?",
            [accountId],
          )
        )
          return;
        if (snapshot.full)
          this.db.run("DELETE FROM mail_contact_entries WHERE account_id=?", [
            accountId,
          ]);
        for (const item of snapshot.changes) {
          const previous = this.db.get(
            "SELECT name,addresses_json FROM mail_contact_entries WHERE account_id=? AND provider_id=?",
            [accountId, item.id],
          );
          const addresses =
            item.addresses ??
            (previous
              ? z
                  .array(mailAddressSchema)
                  .parse(JSON.parse(z.string().parse(previous.addresses_json)))
              : []);
          const name =
            item.name ?? (previous ? z.string().parse(previous.name) : "");
          if (item.deleted || !addresses.length)
            this.db.run(
              "DELETE FROM mail_contact_entries WHERE account_id=? AND provider_id=?",
              [accountId, item.id],
            );
          else
            this.db.run(
              "INSERT INTO mail_contact_entries(account_id,provider_id,name,addresses_json) VALUES(?,?,?,?) ON CONFLICT(account_id,provider_id) DO UPDATE SET name=excluded.name,addresses_json=excluded.addresses_json",
              [accountId, item.id, name, JSON.stringify(addresses)],
            );
        }
        const count = this.db.get(
          "SELECT count(*) AS n FROM mail_contact_entries WHERE account_id=?",
          [accountId],
        )?.n;
        if (typeof count !== "number" || count > 20000)
          throw new ContactsError("limit");
        this.db.run(
          "UPDATE mail_contact_books SET cursor=?,last_sync_at=?,error=NULL WHERE account_id=?",
          [snapshot.cursor, Date.now(), accountId],
        );
      });
    } catch (error) {
      if ((!signal.aborted || timedOut) && !this.closed && !this.paused) {
        const code =
          error instanceof ContactsError && error.code !== "expired"
            ? error.code
            : "unavailable";
        this.db.run(
          "UPDATE mail_contact_books SET error=? WHERE account_id=?",
          [code, accountId],
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
  cancel(accountId: string) {
    this.pending.get(accountId)?.controller.abort();
  }
  async suspend() {
    this.paused = true;
    for (const value of this.pending.values()) value.controller.abort();
    await Promise.allSettled(
      [...this.pending.values()].map((value) => value.promise),
    );
  }
  resume() {
    if (this.closed) return;
    this.paused = false;
    this.refreshDue();
  }
  async close() {
    this.closed = true;
    await this.suspend();
  }
}
