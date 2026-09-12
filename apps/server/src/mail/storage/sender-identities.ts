import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {MailDatabase} from './database-interface.js';
import {MailCredentialRepository} from './credentials.js';
import {GraphMailboxRepository} from './graph-mailboxes.js';
import {senderIdentitySchema,senderSettingsSchema,senderConfigureSchema,type SenderIdentity,type SenderSettings,type SenderConfigure} from '../sender-view.js';
export const SENDER_IDENTITY_SQL=`CREATE TABLE mail_sender_identities (
 account_id TEXT NOT NULL REFERENCES mail_accounts(id),id TEXT NOT NULL,address TEXT NOT NULL,display_name TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('provider_verified','user_confirmed')),generation TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN (0,1)),
 signature TEXT NOT NULL DEFAULT '',default_new INTEGER NOT NULL DEFAULT 0 CHECK(default_new IN (0,1)),default_reply INTEGER NOT NULL DEFAULT 0 CHECK(default_reply IN (0,1)),
 PRIMARY KEY(account_id,id),UNIQUE(account_id,address));`;
export class SenderIdentityError extends Error {constructor(){super('mail_sender_unavailable');}}
const identityId=(accountId:string,address:string)=>createHash('sha256').update(JSON.stringify([accountId,address.toLowerCase()])).digest('hex');
export class SenderIdentityRepository {
 constructor(private readonly db:MailDatabase,private readonly ownerId:string){}
 private account(accountId:string){const row=this.db.get('SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?',[accountId,this.ownerId]);if(!row)throw new SenderIdentityError();return row;}
 private status(accountId:string){this.account(accountId);return new MailCredentialRepository(this.db,this.ownerId).status(accountId);}
 list(accountId:string):SenderIdentity[]{
  const status=this.status(accountId),shared=this.account(accountId).provider==='graph'?new GraphMailboxRepository(this.db,this.ownerId).identity(accountId):undefined;
  if(shared){const id=identityId(accountId,shared.address);const row=this.db.get('SELECT signature,default_new,default_reply FROM mail_sender_identities WHERE account_id=? AND id=?',[accountId,id]);
   return [senderIdentitySchema.parse({id,accountId,address:shared.address,displayName:'',source:'administrator_confirmed',available:status.state==='connected'&&!status.archiveLocked&&shared.sendAllowed,signature:row?.signature??'',defaultNew:true,defaultReply:true,sendMode:shared.sendMode==='none'?'send_as':shared.sendMode})];}
  const provider=this.account(accountId).provider;const scopes=provider==='imap'?[]:z.array(z.string()).parse(JSON.parse(z.string().parse(this.db.get('SELECT granted_scopes_json FROM mail_account_credentials WHERE account_id=?',[accountId])?.granted_scopes_json??'[]')));
  const sendGrant=provider==='imap'||(provider==='gmail'?scopes.includes('https://www.googleapis.com/auth/gmail.modify'):scopes.some(value=>value==='Mail.Send'||value==='https://graph.microsoft.com/Mail.Send'));
  return this.db.all('SELECT * FROM mail_sender_identities WHERE account_id=? ORDER BY active DESC,address LIMIT 100',[accountId]).map(row=>senderIdentitySchema.parse({id:row.id,accountId,address:row.address,displayName:row.display_name,source:row.source,
   available:sendGrant&&status.state==='connected'&&!status.archiveLocked&&row.active===1&&row.generation===status.version?.generation,signature:row.signature,defaultNew:row.default_new===1,defaultReply:row.default_reply===1,sendMode:'self'}));
 }
 invalidate(accountId:string){this.account(accountId);this.db.run('UPDATE mail_sender_identities SET active=0 WHERE account_id=?',[accountId]);}
 /** Replace a complete authenticated discovery atomically; preserve local preferences by stable address. */
 replace(accountId:string,generation:string,values:{address:string;displayName:string;primary:boolean;default:boolean}[],source:'provider_verified'|'user_confirmed'='provider_verified'){
  return this.db.transaction(()=>{const status=this.status(accountId);if(status.state!=='connected'||status.archiveLocked||status.version.generation!==generation||values.length>100)throw new SenderIdentityError();
   const previous=this.list(accountId);this.db.run('UPDATE mail_sender_identities SET active=0 WHERE account_id=?',[accountId]);
   for(const value of values){const normalized=senderIdentitySchema.shape.address.parse(value.address);const id=identityId(accountId,normalized);
    this.db.run(`INSERT INTO mail_sender_identities(account_id,id,address,display_name,source,generation,active) VALUES(?,?,?,?,?,?,1)
     ON CONFLICT(account_id,id) DO UPDATE SET display_name=excluded.display_name,source=excluded.source,generation=excluded.generation,active=1`,[accountId,id,normalized,value.displayName,source,generation]);}
   for(const field of ['default_new','default_reply']){const old=previous.find(value=>field==='default_new'?value.defaultNew:value.defaultReply);if(!old||!values.some(value=>value.address.toLowerCase()===old.address)){const selected=values.find(value=>value.default)??values.find(value=>value.primary)??values[0];this.db.run(`UPDATE mail_sender_identities SET ${field}=0 WHERE account_id=?`,[accountId]);if(selected)this.db.run(`UPDATE mail_sender_identities SET ${field}=1 WHERE account_id=? AND id=?`,[accountId,identityId(accountId,selected.address)]);}}
   return this.list(accountId);
  });
 }
 configure(accountId:string,supplied:SenderConfigure){const input=senderConfigureSchema.parse(supplied);if(this.account(accountId).provider!=='imap')throw new SenderIdentityError();const status=this.status(accountId);if(status.state!=='connected'||status.archiveLocked)throw new SenderIdentityError();
  const existing=this.list(accountId).filter(value=>value.available&&(!input.remove||value.address!==input.address)).map(value=>({address:value.address,displayName:value.displayName,primary:false,default:value.defaultNew}));
  if(!input.remove&&!existing.some(value=>value.address===input.address))existing.push({address:input.address,displayName:'',primary:existing.length===0,default:existing.length===0});return this.replace(accountId,status.version.generation,existing,'user_confirmed');
 }
 settings(accountId:string,supplied:SenderSettings){const input=senderSettingsSchema.parse(supplied);return this.db.transaction(()=>{const selected=this.list(accountId).find(value=>value.id===input.identityId);if(!selected)throw new SenderIdentityError();
  if(selected.source==='administrator_confirmed'){const status=this.status(accountId);this.db.run(`INSERT OR IGNORE INTO mail_sender_identities(account_id,id,address,display_name,source,generation,active) VALUES(?,?,?,'','user_confirmed',?,1)`,[accountId,selected.id,selected.address,status.version?.generation??'']);}
  if(input.defaultNew)this.db.run('UPDATE mail_sender_identities SET default_new=0 WHERE account_id=?',[accountId]);if(input.defaultReply)this.db.run('UPDATE mail_sender_identities SET default_reply=0 WHERE account_id=?',[accountId]);
  this.db.run('UPDATE mail_sender_identities SET signature=?,default_new=?,default_reply=? WHERE account_id=? AND id=?',[input.signature,Number(input.defaultNew),Number(input.defaultReply),accountId,input.identityId]);return this.list(accountId);
 });}
 assertSender(accountId:string,content:{senderIdentityId?:string|null;from:string|null}){const selected=this.list(accountId).find(value=>value.id===content.senderIdentityId&&value.available&&value.address===content.from?.toLowerCase());if(!selected)throw new SenderIdentityError();if(this.account(accountId).provider==='graph')new GraphMailboxRepository(this.db,this.ownerId).assertSender(accountId,selected.address);return selected;}
}
