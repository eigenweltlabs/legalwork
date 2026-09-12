import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {MailDatabase} from './database-interface.js';
import {MailContentStore} from './content-store.js';
const count=z.number().int().nonnegative();
export const mailBackupInventorySchema=z.object({version:z.literal(1),accounts:count,messages:count,references:count,bytes:count,retainedRecords:count,retainedParts:count,incompleteParts:count,digest:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export type MailBackupInventory=z.infer<typeof mailBackupInventorySchema>;
/** Trusted offline maintenance only. Validate the entire encrypted blob/reference inventory. */
export function mailBackupInventory(db:MailDatabase,ownerId:string):MailBackupInventory{
 if(db.get('SELECT 1 FROM mail_accounts WHERE owner_id<>? LIMIT 1',[ownerId]))throw Error('mail_inventory_failed');
 if(db.get('SELECT 1 FROM mail_content_refs r LEFT JOIN mail_blob_publications p ON p.account_id=r.account_id AND p.ref_id=r.id WHERE p.object_id IS NULL LIMIT 1'))throw Error('mail_inventory_failed');
 const digest=createHash('sha256'),content=new MailContentStore(db,ownerId);let afterAccount='',references=0,bytes=0;
 while(true){const accounts=db.all('SELECT id FROM mail_accounts WHERE owner_id=? AND id>? ORDER BY id LIMIT 100',[ownerId,afterAccount]);if(!accounts.length)break;for(const account of accounts){const accountId=z.string().parse(account.id);afterAccount=accountId;let afterRef='';while(true){const refs=db.all('SELECT id,bytes,sha256 FROM mail_content_refs WHERE account_id=? AND id>? ORDER BY id LIMIT 100',[accountId,afterRef]);if(!refs.length)break;for(const ref of refs){const refId=z.string().parse(ref.id),size=count.parse(ref.bytes),hash=z.string().parse(ref.sha256);afterRef=refId;for(const chunk of content.read(accountId,refId))chunk.fill(0);digest.update(JSON.stringify([accountId,refId,size,hash])+'\n');references++;bytes+=size;if(!Number.isSafeInteger(bytes))throw Error('mail_inventory_failed');}}}}
 let afterSnapshot='';while(true){const rows=db.all('SELECT id,manifest_json,manifest_hash FROM mail_filing_snapshots WHERE id>? ORDER BY id LIMIT 100',[afterSnapshot]);if(!rows.length)break;for(const row of rows){afterSnapshot=z.string().parse(row.id);const json=z.string().parse(row.manifest_json);if(createHash('sha256').update(json).digest('hex')!==row.manifest_hash)throw Error('mail_inventory_failed');digest.update(JSON.stringify([afterSnapshot,json]));}}
 if(db.get('SELECT 1 FROM mail_filing_parts p JOIN mail_content_refs r ON r.account_id=p.account_id AND r.id=p.ref_id WHERE p.bytes<>r.bytes OR p.sha256<>r.sha256 LIMIT 1'))throw Error('mail_inventory_failed');
 const tableCount=(table:'mail_filing_snapshots'|'mail_filing_parts')=>db.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",[table])?count.parse(db.get(`SELECT count(*) n FROM ${table}`)?.n):0;
 const inventory={version:1,accounts:count.parse(db.get('SELECT count(*) n FROM mail_accounts')?.n),messages:count.parse(db.get('SELECT count(*) n FROM mail_messages')?.n),references,bytes,retainedRecords:tableCount('mail_filing_snapshots'),retainedParts:tableCount('mail_filing_parts'),incompleteParts:count.parse(db.get("SELECT count(*) n FROM mail_content_manifests WHERE state<>'stored'")?.n)};
 digest.update(JSON.stringify(inventory));return mailBackupInventorySchema.parse({...inventory,digest:digest.digest('hex')});
}
