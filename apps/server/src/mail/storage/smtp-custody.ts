import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {MailDatabase} from './database-interface.js';
import {MailCredentialRepository} from './credentials.js';
import {smtpConfigureSchema,smtpSettingsSchema,type SmtpConfigure,OutboxError} from '../outbox-view.js';
export class SmtpCustody{
 constructor(private readonly db:MailDatabase,private readonly ownerId:string){}
 private account(accountId:string){if(!this.db.get("SELECT id FROM mail_accounts WHERE id=? AND owner_id=? AND provider='imap'",[accountId,this.ownerId]))throw new OutboxError('smtp_unconfigured');return new MailCredentialRepository(this.db,this.ownerId).status(accountId);}
 status(accountId:string){const status=this.account(accountId),row=this.db.get('SELECT settings_json,account_generation FROM mail_smtp_credentials WHERE account_id=?',[accountId]);return{configured:!!row,settings:row?smtpSettingsSchema.parse(JSON.parse(z.string().parse(row.settings_json))):null,current:!!row&&status.state==='connected'&&!status.archiveLocked&&status.version.generation===row.account_generation};}
 configure(accountId:string,supplied:SmtpConfigure){const input=smtpConfigureSchema.parse(supplied);return this.db.transaction(()=>{const status=this.account(accountId);if(status.state!=='connected'||status.archiveLocked)throw new OutboxError('credentials_changed');const{password,...settings}=input;this.db.run(`INSERT INTO mail_smtp_credentials(account_id,generation,revision,account_generation,settings_json,password) VALUES(?,?,1,?,?,?) ON CONFLICT(account_id) DO UPDATE SET generation=excluded.generation,revision=revision+1,account_generation=excluded.account_generation,settings_json=excluded.settings_json,password=excluded.password`,[accountId,randomUUID(),status.version.generation,JSON.stringify(settings),password]);return this.status(accountId);});}
 read(accountId:string){if(!this.status(accountId).current)throw new OutboxError('smtp_unconfigured');const row=this.db.get('SELECT generation,settings_json,password FROM mail_smtp_credentials WHERE account_id=?',[accountId]);return{generation:z.string().parse(row?.generation),settings:smtpSettingsSchema.parse(JSON.parse(z.string().parse(row?.settings_json))),password:z.string().parse(row?.password)};}
 assert(accountId:string,generation:string){if(this.read(accountId).generation!==generation)throw new OutboxError('credentials_changed');}
 remove(accountId:string){this.account(accountId);this.db.run('DELETE FROM mail_smtp_credentials WHERE account_id=?',[accountId]);return this.status(accountId);}
}
