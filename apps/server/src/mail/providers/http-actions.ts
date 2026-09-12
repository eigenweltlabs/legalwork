import { z } from 'zod';
import { mailMutationSchema, type MailMutation } from '../local-view.js';
import { gmailMutationPrecondition, graphMutationPrecondition, folderMutationPrecondition } from '../storage/mutation-precondition.js';
import type { OAuthFetch } from './oauth.js';

export type MutationOutcome = 'confirmed' | 'unknown' | 'unsupported' | 'conflict' | 'rejected';
export class MailMutationHttpError extends Error {
  constructor(readonly status: number) { super('mail_mutation_provider_unavailable'); }
  get retryable() { return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500; }
  get rejected() { return [400, 401, 403, 404, 405, 409, 412, 422, 429].includes(this.status); }
}
const remoteId = z.string().min(1).max(4096).refine(value => value !== '.' && value !== '..' && !/[\x00-\x20\x7f]/.test(value));
const name = z.string().min(1).max(512).refine(value => !/[\r\n\0]/.test(value));
const gmailMessage = z.object({id:remoteId,labelIds:z.array(remoteId).max(10000).default([])});
const graphMessage = z.object({id:remoteId,changeKey:remoteId,parentFolderId:remoteId,isRead:z.boolean(),flag:z.object({flagStatus:z.enum(['flagged','notFlagged','complete'])}).optional()});

/** Fixed-origin writes with fresh observations and a caller-owned durable dispatch boundary.
 * HTTP preflight is best effort: Gmail and Graph do not promise atomic CAS for every action.
 * A transport interruption after dispatch is never permission to replay a write. */
export class MailHttpActions {
  private readonly base: string;
  private readonly fetch: OAuthFetch;
  constructor(private readonly options: {provider:'gmail'|'graph';accessToken:string;grantedScopes:readonly string[];mailboxAddress?:string|null;fetch?:OAuthFetch}) {
    if (!/^[\x21-\x7e]{1,16384}$/.test(options.accessToken)) throw new MailMutationHttpError(400);
    const address = options.mailboxAddress ? z.string().email().max(320).parse(options.mailboxAddress) : null;
    if (address && options.provider !== 'graph') throw new MailMutationHttpError(400);
    this.base = options.provider === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me' : 'https://graph.microsoft.com/v1.0' + (address ? '/users/' + encodeURIComponent(address) : '/me');
    this.fetch = options.fetch ?? fetch;
  }
  private async request(path: string, signal: AbortSignal, method = 'GET', body?: object): Promise<unknown> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    let response: Response;
    try {
      response = await this.fetch(this.base + path, {method,signal:bounded,redirect:'error',credentials:'omit',cache:'no-store',
        headers:{Authorization:'Bearer '+this.options.accessToken,Accept:'application/json',Prefer:'IdType="ImmutableId"',...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{})});
    } catch { throw new MailMutationHttpError(0); }
    if (bounded.aborted || response.redirected || !response.ok) {
      void response.body?.cancel().catch(()=>{});
      throw new MailMutationHttpError(bounded.aborted || response.redirected ? 0 : response.status);
    }
    if (response.status === 204) { void response.body?.cancel().catch(()=>{}); return null; }
    const reader = response.body?.getReader();
    if (!reader) return null;
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (bounded.aborted) throw new MailMutationHttpError(0);
        if (done) break;
        size += value.byteLength;
        if (size > 2*1024*1024 || chunks.length > 10000) throw new MailMutationHttpError(0);
        chunks.push(value);
      }
      if (!size) return null;
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    } finally { void reader.cancel().catch(()=>{}); reader.releaseLock(); }
  }
  private writable(permanent = false) {
    return this.options.provider === 'gmail'
      ? this.options.grantedScopes.includes('https://mail.google.com/') || !permanent && this.options.grantedScopes.includes('https://www.googleapis.com/auth/gmail.modify')
      : this.options.grantedScopes.some(scope=>scope === (this.options.mailboxAddress ? 'Mail.ReadWrite.Shared' : 'Mail.ReadWrite') || scope === 'https://graph.microsoft.com/' + (this.options.mailboxAddress ? 'Mail.ReadWrite.Shared' : 'Mail.ReadWrite'));
  }
  async mutate(supplied: MailMutation, signal: AbortSignal, dispatch: () => void): Promise<MutationOutcome> {
    const input = mailMutationSchema.parse(supplied);
    if (!this.writable(input.change.kind==='delete')) return 'unsupported';
    if (input.change.kind==='mailbox') return this.mailbox(input, signal, dispatch);
    if (!input.locator || input.locator.provider!==this.options.provider) return 'unsupported';
    const path = '/messages/'+encodeURIComponent(remoteId.parse(input.locator.messageId));
    return this.options.provider==='gmail' ? this.gmail(input,path,signal,dispatch) : this.graph(input,path,signal,dispatch);
  }
  private async gmail(input: MailMutation, path: string, signal: AbortSignal, dispatch: () => void): Promise<MutationOutcome> {
    if (!input.locator || input.locator.provider!=='gmail') return 'unsupported';
    const before = gmailMessage.parse(await this.request(path+'?format=minimal',signal));
    if (before.id !== input.locator.messageId || gmailMutationPrecondition(before.labelIds)!==input.precondition) return 'conflict';
    const change = input.change;
    let add: string[] = [], remove: string[] = [], suffix = '/modify', method = 'POST';
    if (change.kind==='read') { add=change.read?[]:['UNREAD'];remove=change.read?['UNREAD']:[]; }
    else if (change.kind==='flags') {
      if ([...change.add,...change.remove].some(flag=>flag!=='\\Flagged')) return 'unsupported';
      add=change.add.length?['STARRED']:[];remove=change.remove.length?['STARRED']:[];
    } else if (change.kind==='memberships') {add=change.add;remove=change.remove;}
    else if (change.kind==='move') {add=[change.destination];remove=['INBOX'];}
    else if (change.kind==='special') {
      if (change.operation==='archive') remove=['INBOX'];
      if (change.operation==='trash') {suffix='/trash';add=['TRASH'];remove=['INBOX'];}
      if (change.operation==='spam') {add=['SPAM'];remove=['INBOX'];}
      if (change.operation==='inbox') {add=['INBOX'];remove=['SPAM','TRASH'];}
    } else if (change.kind==='delete') {suffix='';method='DELETE';}
    else return 'unsupported';
    if (add.some(id=>remove.includes(id))) return 'conflict';
    // Drafts and Sent have provider-owned lifecycle; they are not arbitrary label edits.
    if ([...add,...remove].some(id=>['DRAFT','SENT','CHAT'].includes(id))) return 'unsupported';
    if (change.kind==='memberships'||change.kind==='move') {
      const labels = z.object({labels:z.array(z.object({id:remoteId})).max(10000)}).parse(await this.request('/labels',signal));
      if ([...add,...remove].some(id=>!labels.labels.some(label=>label.id===id))) return 'conflict';
    }
    dispatch();
    await this.request(path+suffix,signal,method,suffix==='/modify'?{addLabelIds:add,removeLabelIds:remove}:undefined);
    if (change.kind==='delete') return 'confirmed';
    let after: z.infer<typeof gmailMessage>;
    try { after = gmailMessage.parse(await this.request(path+'?format=minimal',signal)); } catch { return 'unknown'; }
    return after.id===before.id && add.every(id=>after.labelIds.includes(id)) && remove.every(id=>!after.labelIds.includes(id)) ? 'confirmed' : 'unknown';
  }
  private async graph(input: MailMutation, path: string, signal: AbortSignal, dispatch: () => void): Promise<MutationOutcome> {
    if (!input.locator || input.locator.provider!=='graph') return 'unsupported';
    const select = '?$select=id,changeKey,parentFolderId,isRead,flag';
    const before = graphMessage.parse(await this.request(path+select,signal));
    if (before.id!==input.locator.messageId || graphMutationPrecondition(before.changeKey)!==input.precondition) return 'conflict';
    const change = input.change;
    let body: object | undefined, suffix = '', method = 'PATCH', destination: string | undefined;
    if (change.kind==='read') body={isRead:change.read};
    else if (change.kind==='flags') {
      if ([...change.add,...change.remove].some(flag=>flag!=='\\Flagged') || change.add.some(flag=>change.remove.includes(flag))) return 'unsupported';
      body={flag:{flagStatus:change.add.length?'flagged':'notFlagged'}};
    } else if (change.kind==='move'||change.kind==='copy'||change.kind==='special') {
      const target = change.kind==='special' ? {archive:'archive',trash:'deleteditems',spam:'junkemail',inbox:'inbox'}[change.operation] : change.destination;
      const folder = z.object({id:remoteId}).parse(await this.request('/mailFolders/'+encodeURIComponent(remoteId.parse(target))+'?$select=id',signal));
      if (before.parentFolderId===folder.id) return 'conflict';
      destination=folder.id;body={destinationId:folder.id};suffix=change.kind==='copy'?'/copy':'/move';method='POST';
    } else if (change.kind==='delete') {suffix='/permanentDelete';method='POST';}
    else return 'unsupported';
    dispatch();
    const response = await this.request(path+suffix,signal,method,body);
    if (change.kind==='delete') return 'confirmed';
    if (suffix==='/copy') {
      const copy = z.object({id:remoteId,parentFolderId:remoteId}).parse(response);
      return copy.id!==before.id && copy.parentFolderId===destination ? 'confirmed' : 'unknown';
    }
    let after: z.infer<typeof graphMessage>;
    try { after = graphMessage.parse(await this.request(path+select,signal)); } catch { return 'unknown'; }
    if (after.id!==before.id) return 'unknown';
    if (destination) return after.parentFolderId===destination?'confirmed':'unknown';
    if (change.kind==='read') return after.isRead===change.read?'confirmed':'unknown';
    if (change.kind==='flags') return after.flag?.flagStatus===(change.add.length?'flagged':'notFlagged')?'confirmed':'unknown';
    return 'unknown';
  }
  private async mailbox(input: MailMutation, signal: AbortSignal, dispatch: () => void): Promise<MutationOutcome> {
    const change = input.change;
    if (change.kind!=='mailbox'||input.locator) return 'unsupported';
    const gmail = this.options.provider==='gmail', collection=gmail?'/labels':'/mailFolders';
    if (change.operation==='create') {
      if (input.precondition!==this.options.provider+'-mailbox-v1') return 'conflict';
      name.parse(change.path); dispatch();
      const created = z.object({id:remoteId}).parse(await this.request(collection,signal,'POST',gmail?{name:change.path}:{displayName:change.path}));
      return created.id ? 'confirmed' : 'unknown';
    }
    const path = collection+'/'+encodeURIComponent(remoteId.parse(change.path));
    const value = await this.request(path,signal);
    if (gmail) {
      const folder = z.object({id:remoteId,name,type:z.enum(['user','system'])}).parse(value);
      if (folder.id!==change.path||folder.type!=='user'||folderMutationPrecondition({name:folder.name,parentId:null})!==input.precondition) return 'conflict';
    } else {
      const folder = z.object({id:remoteId,displayName:name,parentFolderId:remoteId,totalItemCount:z.number().int().nonnegative(),childFolderCount:z.number().int().nonnegative()}).parse(value);
      if (folder.id!==change.path||folderMutationPrecondition({name:folder.displayName,parentId:folder.parentFolderId})!==input.precondition) return 'conflict';
      // Never turn removing a folder into an implicit bulk message deletion.
      if (change.operation==='delete'&&(folder.totalItemCount||folder.childFolderCount)) return 'conflict';
      for (const wellKnown of ['inbox','drafts','sentitems','deleteditems','junkemail','archive','outbox']) {
        try {
          const protectedFolder=z.object({id:remoteId}).parse(await this.request('/mailFolders/'+wellKnown+'?$select=id',signal));
          if (protectedFolder.id===folder.id) return 'unsupported';
        } catch(error) { if (!(error instanceof MailMutationHttpError) || error.status!==404) throw error; }
      }
    }
    if (change.operation==='rename') name.parse(change.destination);
    dispatch();
    await this.request(path,signal,change.operation==='delete'?'DELETE':'PATCH',change.operation==='rename'?(gmail?{name:change.destination}:{displayName:change.destination}):undefined);
    return 'confirmed';
  }
}
