import { z } from "zod";
import type { MailDatabase } from "./database-interface.js";
import { MailRepository } from "./repository.js";
import { MailCredentialRepository, type MailCredentialBinding, type MailCredentialVersion } from "./credentials.js";
import { SenderIdentityRepository } from "./sender-identities.js";
import { mailIntegrationAccountSchema, mailIntegrationAuthority, mailIntegrationReference, mailIntegrationSnapshotSchema, type MailIntegrationAccount, type MailIntegrationSnapshot } from "../integration-view.js";

export const MAIL_INTEGRATIONS_SCHEMA_SQL = `CREATE TABLE mail_integration_accounts (
  account_id TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  handle TEXT NOT NULL, account_json TEXT NOT NULL
);`;
export const MAIL_INTEGRATION_ADOPTION_SQL = `
  ALTER TABLE mail_integration_accounts ADD COLUMN source_account_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE mail_integration_accounts ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0 CHECK(read_only IN (0,1));
  ALTER TABLE mail_integration_accounts ADD COLUMN previous_binding_json TEXT;
  UPDATE mail_integration_accounts SET source_account_id=account_id;
  CREATE UNIQUE INDEX mail_integration_primary ON mail_integration_accounts(source_account_id) WHERE read_only=0;
`;

/** Encrypted mailbox metadata only. Integrations retains all OAuth credentials. */
export class MailIntegrationAccounts {
  private readonly credentials: MailCredentialRepository;
  constructor(private readonly db: MailDatabase, private readonly ownerId: string) {
    this.credentials = new MailCredentialRepository(db, ownerId);
  }
  get(accountId: string) {
    const row = this.db.get("SELECT i.account_json,i.read_only,i.previous_binding_json FROM mail_integration_accounts i JOIN mail_accounts a ON a.id=i.account_id WHERE a.id=? AND a.owner_id=?", [accountId, this.ownerId]);
    return row ? { ...mailIntegrationAccountSchema.parse(JSON.parse(z.string().parse(row.account_json))), readOnly:row.read_only===1, adopted:row.previous_binding_json!==null } : undefined;
  }
  primary(sourceAccountId: string) {
    const row=this.db.get("SELECT i.account_id FROM mail_integration_accounts i JOIN mail_accounts a ON a.id=i.account_id WHERE a.owner_id=? AND i.source_account_id=? AND i.read_only=0",[this.ownerId,sourceAccountId]);
    return row ? z.string().parse(row.account_id) : undefined;
  }
  legacyAccounts(provider: "gmail" | "graph") {
    return this.db.all("SELECT a.id FROM mail_accounts a JOIN mail_account_credentials c ON c.account_id=a.id LEFT JOIN mail_integration_accounts i ON i.account_id=a.id WHERE a.owner_id=? AND a.provider=? AND c.state='connected' AND c.authority!=? AND i.account_id IS NULL ORDER BY a.id LIMIT 32",[this.ownerId,provider,mailIntegrationAuthority]).map(row=>z.string().parse(row.id));
  }
  private connect(accountId: string, account: MailIntegrationAccount, readOnly: boolean) {
    const status=this.credentials.status(accountId);
    const binding:MailCredentialBinding={provider:account.connectorId==='gmail'?'gmail':'graph',clientId:mailIntegrationAuthority,authority:mailIntegrationAuthority,providerSubject:account.handle};
    const version=this.credentials.connect(accountId,binding,status.version,{accessToken:mailIntegrationReference(account.accountId),expiresAt:Number.MAX_SAFE_INTEGER,grantedScopes:readOnly?[]:account.scopes,refreshToken:{action:'clear'}});
    const senders=new SenderIdentityRepository(this.db,this.ownerId);
    if(readOnly)senders.invalidate(accountId);
    else senders.replace(accountId,version.generation,[{address:account.email,displayName:account.displayName,primary:true,default:true}]);
  }
  /** Called only after live provider identity proof. CAS fences late refreshes.
   * The local account ID, originals, drafts, grants and action history stay put. */
  adopt(accountId: string, value: MailIntegrationAccount, expected: MailCredentialVersion) {
    const account=mailIntegrationAccountSchema.parse(value);
    return this.db.transaction(()=>{
      const status=this.credentials.status(accountId),binding=this.credentials.getBinding(accountId);
      if(status.state!=='connected'||status.version.generation!==expected.generation||status.version.revision!==expected.revision||binding.authority===mailIntegrationAuthority||binding.provider!==(account.connectorId==='gmail'?'gmail':'graph'))throw Error('mail_integration_stale_proof');
      const readOnly=this.primary(account.accountId)!==undefined;
      const disconnected=this.credentials.disconnect(accountId,expected);
      this.db.run("UPDATE mail_account_credentials SET client_id=?,authority=?,provider_subject=? WHERE account_id=? AND generation=? AND revision=? AND state='disconnected'",[mailIntegrationAuthority,mailIntegrationAuthority,account.handle,accountId,disconnected.generation,disconnected.revision]);
      this.db.run("INSERT INTO mail_integration_accounts(account_id,handle,account_json,source_account_id,read_only,previous_binding_json) VALUES(?,?,?,?,?,?)",[accountId,account.handle,JSON.stringify(account),account.accountId,readOnly?1:0,JSON.stringify(binding)]);
      this.connect(accountId,account,readOnly);
      return {accountId,readOnly};
    });
  }
  reconcile(value: MailIntegrationSnapshot) {
    const snapshot = mailIntegrationSnapshotSchema.parse(value);
    const present = new Set(snapshot.handles), verified = new Set(snapshot.accounts.map(account => account.accountId));
    if (snapshot.accounts.some(account => !present.has(account.handle)) || verified.size !== snapshot.accounts.length) throw new Error("mail_integration_invalid_snapshot");
    return this.db.transaction(() => {
      const changed: string[] = [], disconnected: string[] = [];
      for (const row of this.db.all("SELECT i.account_id,i.handle,i.source_account_id FROM mail_integration_accounts i JOIN mail_accounts a ON a.id=i.account_id WHERE a.owner_id=?", [this.ownerId])) {
        const accountId = z.string().parse(row.account_id);
        // A handle may exist while verification is temporarily unavailable.
        // Preserve its local archive; the host still rejects unverified access.
        if ((present.has(z.string().parse(row.handle)) && !snapshot.accounts.some(account => account.handle === row.handle)) || verified.has(z.string().parse(row.source_account_id))) continue;
        const status = this.credentials.status(accountId);
        if (status.state === "connected") { this.credentials.disconnect(accountId, status.version); disconnected.push(accountId); }
      }
      const repository = new MailRepository(this.db, this.ownerId);
      for (const account of snapshot.accounts) {
        if(!this.primary(account.accountId)){
          repository.createAccount({id:account.accountId,provider:account.connectorId==='gmail'?'gmail':'graph',displayName:`${account.displayName} <${account.email}>`});
          this.db.run("INSERT INTO mail_integration_accounts(account_id,handle,account_json,source_account_id) VALUES(?,?,?,?)",[account.accountId,account.handle,JSON.stringify(account),account.accountId]);
        }
        for(const row of this.db.all("SELECT i.account_id FROM mail_integration_accounts i JOIN mail_accounts a ON a.id=i.account_id WHERE a.owner_id=? AND i.source_account_id=?",[this.ownerId,account.accountId])){
          const accountId=z.string().parse(row.account_id),previous=this.get(accountId)!;
          const status=this.credentials.status(accountId),scopeChanged=JSON.stringify(previous.scopes.slice().sort())!==JSON.stringify(account.scopes.slice().sort());
          if(status.state!=='connected'||scopeChanged){this.connect(accountId,account,previous.readOnly);changed.push(accountId);}
          this.db.run("UPDATE mail_accounts SET display_name=? WHERE id=? AND owner_id=?",[`${account.displayName} <${account.email}>${previous.readOnly?' (retained copy)':''}`,accountId,this.ownerId]);
          this.db.run("UPDATE mail_integration_accounts SET account_json=? WHERE account_id=?",[JSON.stringify(account),accountId]);
        }
      }
      return { changed, disconnected };
    });
  }
}
