import {mailBackupInventory,type MailBackupInventory} from './backup-inventory.js';
import { quarantineRestoredMail } from "./recovery-quarantine.js";
import { MailSearchStore } from "./search.js";
import { resetMailLocalEventStreams } from "./local-schema.js";
import { enforceMailWindowsAcl } from "./windows-acl.js";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openEncryptedMailDatabase } from "./database.js";
import { MAIL_SCHEMA_VERSION, migrateMailSchema } from "./schema.js";
import type { MailDatabase } from "./database-interface.js";
export class MailMaintenanceError extends Error { constructor() { super("mail_maintenance_failed"); } }
export type MailMaintenanceInput = { sourcePath: string; destinationPath: string; sourceKey: Uint8Array; destinationKey: Uint8Array; ownerId: string; restore: boolean; expectedSha256: string | null };
/** Offline, trusted main-process maintenance. Never reachable through arbitrary worker commands. */
export async function prepareMailStore(input: MailMaintenanceInput): Promise<{ accounts: number; messages: number; references: number; schemaVersion: number; inventory:MailBackupInventory }> {
  let source: MailDatabase | undefined, destination: MailDatabase | undefined;
  const oldKey = Buffer.from(input.sourceKey), newKey = Buffer.from(input.destinationKey);
  try {
    if (oldKey.length !== 32 || newKey.length !== 32 || !isAbsolute(input.sourcePath) || !isAbsolute(input.destinationPath) || input.sourcePath === input.destinationPath || !input.ownerId || input.ownerId.length > 4096) throw new MailMaintenanceError();
    const directory = await lstat(dirname(input.destinationPath));
    if (!directory.isDirectory() || (process.platform !== "win32" && (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0))) throw new MailMaintenanceError();
    await enforceMailWindowsAcl(dirname(input.destinationPath), true);
    // Never initialize a missing source or follow a filesystem link during recovery.
    const existing = await lstat(input.sourcePath); if (!existing.isFile() || existing.nlink !== 1 || existing.size === 0) throw new MailMaintenanceError();
    if (input.restore) {
      if (typeof input.expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.expectedSha256)) throw new MailMaintenanceError();
      await copyFile(input.sourcePath, input.destinationPath, constants.COPYFILE_EXCL); await chmod(input.destinationPath, 0o600);
      const hash = createHash("sha256"); for await (const chunk of createReadStream(input.destinationPath)) hash.update(chunk);
      if (hash.digest("hex") !== input.expectedSha256) throw new MailMaintenanceError();
    } else {
      source = await openEncryptedMailDatabase({ path: input.sourcePath, key: oldKey });
      if (source.get("SELECT version FROM mail_schema_version WHERE singleton=1")?.version !== MAIL_SCHEMA_VERSION) throw new MailMaintenanceError();
      if (source.get("SELECT 1 FROM mail_accounts WHERE owner_id<>? LIMIT 1", [input.ownerId])) throw new MailMaintenanceError();
      // DELETE mode requires other readers to leave; EXCLUSIVE then fences writers for the copy.
      if (source.get("PRAGMA locking_mode=EXCLUSIVE")?.locking_mode !== "exclusive" || source.get("PRAGMA journal_mode=DELETE")?.journal_mode !== "delete") throw new MailMaintenanceError();
      source.exec("BEGIN EXCLUSIVE");
      await copyFile(input.sourcePath, input.destinationPath, constants.COPYFILE_EXCL); await chmod(input.destinationPath, 0o600);
      source.exec("ROLLBACK"); source.close(); source = undefined;
    }
    destination = await openEncryptedMailDatabase({ path: input.destinationPath, key: oldKey });
    if (input.restore) migrateMailSchema(destination);
    if (destination.get("SELECT version FROM mail_schema_version WHERE singleton=1")?.version !== MAIL_SCHEMA_VERSION || destination.get("SELECT 1 FROM mail_accounts WHERE owner_id<>? LIMIT 1", [input.ownerId])) throw new MailMaintenanceError();
    if (!destination.rekey) throw new MailMaintenanceError(); destination.rekey(newKey);
    if (input.restore) destination.transaction(() => {
      destination?.run("UPDATE mail_imap_credentials SET state='disconnected',archive_locked=1,password=NULL,generation=?,revision=revision+1",[randomUUID()]);
      destination?.run("UPDATE mail_imap_runs SET state='paused',revision=revision+1,retry_at=NULL");
      destination?.run("UPDATE mail_account_credentials SET state='disconnected',archive_locked=1,access_token=NULL,refresh_token=NULL,expires_at=NULL,granted_scopes_json=NULL,generation=?,revision=1", [randomUUID()]);
      destination?.run("UPDATE mail_action_jobs SET state='uncertain',generation=?,revision=1,lease_token=NULL,lease_until=NULL,last_error='outcome_unknown' WHERE state IN ('queued','running','dispatching','retry')", [randomUUID()]);
      destination?.run("UPDATE mail_actions SET state='uncertain' WHERE state IN ('queued','running')");
      destination?.run("UPDATE mail_gmail_runs SET state='paused'");
      // v9 Graph installations may be recovered by this same maintenance path.
      if (destination?.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mail_graph_runs'")) {
        destination.run("UPDATE mail_graph_runs SET state='paused',revision=revision+1,retry_at=NULL");
      }
      destination?.run("UPDATE mail_sync_jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'retry' END,lease_token=NULL,lease_until=NULL,last_error='lease_expired' WHERE state='running'");
      if (destination) { quarantineRestoredMail(destination); resetMailLocalEventStreams(destination); }
    });
    if (destination.get("PRAGMA integrity_check")?.integrity_check !== "ok" || destination.get("SELECT 1 FROM pragma_foreign_key_check LIMIT 1")) throw new MailMaintenanceError();
    const inventory=mailBackupInventory(destination,input.ownerId);
    if(input.restore){const search=new MailSearchStore(destination,input.ownerId,{offlineMaintenance:true});for(const account of destination.all("SELECT id FROM mail_accounts ORDER BY id")){if(typeof account.id!=="string")throw new MailMaintenanceError();let result=search.rebuild({accountId:account.id,reset:true,limit:25});while(result.pending>0){result=search.rebuild({accountId:account.id,limit:25});if(!result.processed&&result.pending)throw new MailMaintenanceError();}}}
    if (destination.get("PRAGMA wal_checkpoint(TRUNCATE)")?.busy !== 0) throw new MailMaintenanceError();
    destination.close(); destination = undefined;
    const file = await open(input.destinationPath, constants.O_RDONLY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); }
    return { accounts:inventory.accounts,messages:inventory.messages,references:inventory.references,schemaVersion:MAIL_SCHEMA_VERSION,inventory };
  } catch { throw new MailMaintenanceError(); }
  finally { source?.close(); destination?.close(); oldKey.fill(0); newKey.fill(0); }
}
