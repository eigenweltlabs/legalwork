import { z } from "zod";
import type { MailDatabase } from "./database-interface.js";
import { MailRepository } from "./repository.js";
import { MailCredentialRepository, type MailCredentialBinding } from "./credentials.js";
import { SenderIdentityRepository } from "./sender-identities.js";
import { mailIntegrationAccountSchema, mailIntegrationAuthority, mailIntegrationReference, mailIntegrationSnapshotSchema, type MailIntegrationSnapshot } from "../integration-view.js";

export const MAIL_INTEGRATIONS_SCHEMA_SQL = `CREATE TABLE mail_integration_accounts (
  account_id TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  handle TEXT NOT NULL, account_json TEXT NOT NULL
);`;

/** Encrypted mailbox metadata only. Integrations retains all OAuth credentials. */
export class MailIntegrationAccounts {
  private readonly credentials: MailCredentialRepository;
  constructor(private readonly db: MailDatabase, private readonly ownerId: string) {
    this.credentials = new MailCredentialRepository(db, ownerId);
  }
  get(accountId: string) {
    const row = this.db.get("SELECT i.account_json FROM mail_integration_accounts i JOIN mail_accounts a ON a.id=i.account_id WHERE a.id=? AND a.owner_id=?", [accountId, this.ownerId]);
    return row ? mailIntegrationAccountSchema.parse(JSON.parse(z.string().parse(row.account_json))) : undefined;
  }
  reconcile(value: MailIntegrationSnapshot) {
    const snapshot = mailIntegrationSnapshotSchema.parse(value);
    const present = new Set(snapshot.handles), verified = new Set(snapshot.accounts.map(account => account.accountId));
    if (snapshot.accounts.some(account => !present.has(account.handle)) || verified.size !== snapshot.accounts.length) throw new Error("mail_integration_invalid_snapshot");
    return this.db.transaction(() => {
      const changed: string[] = [], disconnected: string[] = [];
      for (const row of this.db.all("SELECT i.account_id,i.handle FROM mail_integration_accounts i JOIN mail_accounts a ON a.id=i.account_id WHERE a.owner_id=?", [this.ownerId])) {
        const accountId = z.string().parse(row.account_id);
        // A handle may exist while verification is temporarily unavailable.
        // Preserve its local archive; the host still rejects unverified access.
        if (present.has(z.string().parse(row.handle)) && !snapshot.accounts.some(account => account.handle === row.handle) || verified.has(accountId)) continue;
        const status = this.credentials.status(accountId);
        if (status.state === "connected") { this.credentials.disconnect(accountId, status.version); disconnected.push(accountId); }
      }
      const repository = new MailRepository(this.db, this.ownerId);
      for (const account of snapshot.accounts) {
        const previous = this.get(account.accountId);
        const provider = account.connectorId === "gmail" ? "gmail" : "graph";
        if (!previous) repository.createAccount({ id: account.accountId, provider, displayName: `${account.displayName} <${account.email}>` });
        const status = this.credentials.status(account.accountId);
        const scopeChanged = previous && JSON.stringify(previous.scopes.slice().sort()) !== JSON.stringify(account.scopes.slice().sort());
        if (status.state !== "connected" || scopeChanged) {
          const binding: MailCredentialBinding = { provider, clientId: mailIntegrationAuthority, authority: mailIntegrationAuthority, providerSubject: account.handle };
          const version = this.credentials.connect(account.accountId, binding, status.version, {
            accessToken: mailIntegrationReference(account.accountId), expiresAt: Number.MAX_SAFE_INTEGER,
            grantedScopes: account.scopes, refreshToken: { action: "clear" },
          });
          new SenderIdentityRepository(this.db, this.ownerId).replace(account.accountId, version.generation, [{ address: account.email, displayName: account.displayName, primary: true, default: true }]);
          changed.push(account.accountId);
        }
        this.db.run("UPDATE mail_accounts SET display_name=? WHERE id=? AND owner_id=?", [`${account.displayName} <${account.email}>`, account.accountId, this.ownerId]);
        this.db.run("INSERT INTO mail_integration_accounts(account_id,handle,account_json) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET account_json=excluded.account_json", [account.accountId, account.handle, JSON.stringify(account)]);
      }
      return { changed, disconnected };
    });
  }
}
