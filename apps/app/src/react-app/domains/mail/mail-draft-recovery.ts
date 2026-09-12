import {z} from 'zod';
import {mailDraftContentSchema,mailLocalVersionSchema,type MailDraftSave} from '../../../../../server/src/mail/local-view';
export const recoverySchema=z.object({id:z.string().uuid(),accountId:z.string(),draftId:z.string().uuid(),revision:z.number().int().positive(),version:mailLocalVersionSchema.nullable(),content:mailDraftContentSchema,updatedAt:z.number()});
export type DraftRecovery=z.infer<typeof recoverySchema>;
export async function recoveryDrafts(){const bridge=window.__LEGALWORK_ELECTRON__;return bridge?.mailDraftRecoveryList?z.array(recoverySchema).parse(await bridge.mailDraftRecoveryList()):[];}
/** Main-process serialized fsync journal, separate from the restartable mail worker. */
export class DraftRecoveryJournal{
 private serial:Promise<unknown>=Promise.resolve();private revision:number;readonly id:string;
 constructor(private accountId:string,private draftId:string,recovery?:Pick<DraftRecovery,'id'|'revision'>){this.id=recovery?.id??crypto.randomUUID();this.revision=recovery?.revision??0;}
 write(content:MailDraftSave['content'],version:MailDraftSave['expected']){const operation=this.serial.then(async()=>{const bridge=window.__LEGALWORK_ELECTRON__;if(!bridge?.mailDraftRecoveryWrite)return null;const saved=z.object({id:z.literal(this.id),revision:z.number().int().positive()}).parse(await bridge.mailDraftRecoveryWrite({id:this.id,expected:this.revision,accountId:this.accountId,draftId:this.draftId,version,content}));this.revision=saved.revision;return saved;});this.serial=operation.catch(()=>{});return operation;}
 acknowledge(token:{id:string;revision:number}|null){const operation=this.serial.then(async()=>{if(!token)return;const result=z.object({removed:z.boolean()}).parse(await window.__LEGALWORK_ELECTRON__?.mailDraftRecoveryRemove?.(token));if(result.removed)this.revision=0;});this.serial=operation.catch(()=>{});return operation;}
}
