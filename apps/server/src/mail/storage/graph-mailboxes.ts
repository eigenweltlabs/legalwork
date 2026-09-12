import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MailDatabase } from './database-interface.js';
import { graphMailboxInputSchema, graphMailboxIdentitySchema, type GraphMailboxInput } from '../graph-mailbox-view.js';
const rowSchema = z.object({ account_id:z.string(),credential_account_id:z.string(),mailbox_address:z.string().email(),kind:z.enum(['shared','delegated']),state:z.enum(['connected','revoked','disconnected']),generation:z.string().uuid(),revision:z.number().int(),write_confirmed:z.number(),send_mode:z.enum(['none','send_as','send_on_behalf']) });
export function graphMailboxBasePath(address: string | null): string { return address === null ? '/me' : '/users/' + encodeURIComponent(z.string().email().max(320).parse(address)); }
/** Nonsecret mailbox binding. All queries include the desktop owner. */
export class GraphMailboxRepository {
 constructor(private readonly db: MailDatabase, private readonly ownerId: string) {}
 private account(accountId:string) { if(!this.db.get("SELECT 1 FROM mail_accounts WHERE id=? AND owner_id=? AND provider='graph'",[accountId,this.ownerId]))throw Error('mail_mailbox_not_found'); }
 read(accountId:string) { this.account(accountId);const row=this.db.get('SELECT * FROM mail_graph_mailboxes WHERE account_id=?',[accountId]);return row?rowSchema.parse(row):null; }
 target(accountId:string) { const row=this.read(accountId);return { credentialAccountId:row?.credential_account_id??accountId,mailboxAddress:row?.mailbox_address??null,basePath:graphMailboxBasePath(row?.mailbox_address??null) }; }
 identity(accountId:string) {
  const row=this.read(accountId);if(!row)return undefined;
  const parent=this.db.get("SELECT c.state,c.granted_scopes_json FROM mail_account_credentials c JOIN mail_accounts a ON a.id=c.account_id WHERE a.id=? AND a.owner_id=?",[row.credential_account_id,this.ownerId]);
  const grants=typeof parent?.granted_scopes_json==='string'?z.array(z.string()).parse(JSON.parse(parent.granted_scopes_json)):[];
  const has=(scope:string)=>grants.some(value=>value===scope||value==='https://graph.microsoft.com/'+scope);
  const connected=row.state==='connected'&&parent?.state==='connected';const read=connected&&(has('Mail.Read.Shared')||has('Mail.ReadWrite.Shared'));
  const write=read&&has('Mail.ReadWrite.Shared')&&row.write_confirmed===1;
  const sendAllowed=read&&has('Mail.Send.Shared')&&row.send_mode!=='none';
  const missingGrants=[];
  if(!connected)missingGrants.push('Exchange mailbox access');
  if(!has('Mail.Read.Shared')&&!has('Mail.ReadWrite.Shared'))missingGrants.push('Mail.Read.Shared');
  if(row.write_confirmed===1&&!has('Mail.ReadWrite.Shared'))missingGrants.push('Mail.ReadWrite.Shared');
  if(row.write_confirmed===0)missingGrants.push('Exchange write access');
  if(!has('Mail.Send.Shared'))missingGrants.push('Mail.Send.Shared');
  if(row.send_mode==='none')missingGrants.push('Exchange Send As or Send on Behalf');
  return graphMailboxIdentitySchema.parse({address:row.mailbox_address,kind:row.kind,credentialAccountId:row.credential_account_id,state:parent?.state==='connected'?row.state:'disconnected',writeConfirmed:row.write_confirmed===1,read,write,sendAs:sendAllowed&&row.send_mode==='send_as',sendOnBehalf:sendAllowed&&row.send_mode==='send_on_behalf',sendMode:row.send_mode,sendAllowed,sentItems:'signed_in_mailbox',capabilitySource:'administrator_confirmed',missingGrants,revision:row.revision});
 }
 configuredAccount(credentialAccountId:string,address:string) { this.account(credentialAccountId);const row=this.db.get('SELECT account_id FROM mail_graph_mailboxes WHERE credential_account_id=? AND mailbox_address=?',[credentialAccountId,address.toLowerCase()]);return row?z.string().parse(row.account_id):undefined; }
 configure(supplied:GraphMailboxInput) {
  const input=graphMailboxInputSchema.parse(supplied);this.account(input.credentialAccountId);
  if(this.read(input.credentialAccountId))throw Error('mail_mailbox_parent_required');
  const parent=this.db.get('SELECT state,authority FROM mail_account_credentials WHERE account_id=?',[input.credentialAccountId]);
  if(parent?.state!=='connected'||typeof parent.authority!=='string'||parent.authority.includes('/consumers/'))throw Error('mail_mailbox_parent_required');
  return this.db.transaction(()=>{
   const existing=this.db.get('SELECT account_id FROM mail_graph_mailboxes WHERE credential_account_id=? AND mailbox_address=?',[input.credentialAccountId,input.address]);
   const accountId=existing?z.string().parse(existing.account_id):randomUUID();
   if(!existing)this.db.run("INSERT INTO mail_accounts(id,owner_id,provider,display_name) VALUES(?,?,'graph',?)",[accountId,this.ownerId,input.address]);
   this.db.run("INSERT INTO mail_graph_mailboxes(account_id,credential_account_id,mailbox_address,kind,state,generation,revision,write_confirmed,send_mode) VALUES(?,?,?,?,'connected',?,1,?,?) ON CONFLICT(account_id) DO UPDATE SET kind=excluded.kind,state='connected',generation=excluded.generation,revision=mail_graph_mailboxes.revision+1,write_confirmed=excluded.write_confirmed,send_mode=excluded.send_mode",[accountId,input.credentialAccountId,input.address,input.kind,randomUUID(),input.writeConfirmed?1:0,input.sendMode]);
   return {accountId,identity:this.identity(accountId)};
  });
 }
 revoke(accountId:string,state:'revoked'|'disconnected'='revoked') { if(!this.read(accountId))return;this.db.run('UPDATE mail_graph_mailboxes SET state=?,generation=?,revision=revision+1 WHERE account_id=?',[state,randomUUID(),accountId]); }
 children(parentId:string) { return this.db.all('SELECT s.account_id FROM mail_graph_mailboxes s JOIN mail_accounts a ON a.id=s.account_id WHERE s.credential_account_id=? AND a.owner_id=?',[parentId,this.ownerId]).map(row=>z.string().parse(row.account_id)); }
 fenceChildren(parentId:string) { for(const row of this.db.all('SELECT account_id FROM mail_graph_mailboxes WHERE credential_account_id=?',[parentId]))this.db.run('UPDATE mail_graph_mailboxes SET generation=?,revision=revision+1 WHERE account_id=?',[randomUUID(),z.string().parse(row.account_id)]); }
 submission(accountId:string,address:string|null) { this.assertSender(accountId,address);const target=this.target(accountId),identity=this.identity(accountId);return {credentialAccountId:target.credentialAccountId,basePath:'/me',from:address,saveToSentItems:true,sendMode:identity?.sendMode??'self'}; }
 assertWrite(accountId:string) { const identity=this.identity(accountId);if(identity&&!identity.write)throw Error('mail_mailbox_write_not_allowed'); }
 assertSender(accountId:string,address:string|null) { const identity=this.identity(accountId);if(identity&&(!identity.sendAllowed||address?.toLowerCase()!==identity.address))throw Error('mail_mailbox_sender_not_allowed'); }
}
