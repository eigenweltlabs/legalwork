import type {LegalworkServerClient} from '../../../app/lib/legalwork-server';
import {uploadWorkspaceAttachment,parseWorkspaceAttachmentMention} from '../session/surface/composer/workspace-attachment';
import {encodeComposerMentionValue} from '../session/surface/composer/mention-encoding';
import {getComposerDraft,getComposerMentions,useComposerStateStore} from '../session/surface/composer-state-store';
import {mailChatSourceSchema,mailSourceHref,useMailChatSources,type MailChatSource} from './mail-chat-source';
export type MailChatDestination={workspaceId:string;sessionId:string;client:Pick<LegalworkServerClient,'writeWorkspaceBinaryFile'>;assertCurrent:()=>Promise<void>;open:()=>void};
export type MailChatBridge={workspaces:Array<{id:string;name:string;remote:boolean}>;sessions:(workspaceId:string)=>Promise<Array<{id:string;title:string}>>;prepare:(workspaceId:string,sessionId:string|null)=>Promise<MailChatDestination>};
/** Explicit copy, not an open/preview or a model send. Preserve existing composer contents. */
export async function attachMailToChat(destination:MailChatDestination,file:File,supplied:MailChatSource,signal:AbortSignal,validate:()=>Promise<void>){
 const source=mailChatSourceSchema.parse(supplied);signal.throwIfAborted();
 if(file.size>32*1024*1024)throw Error('Attachments up to 32 MB can be copied to chat.');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),value=>value.toString(16).padStart(2,'0')).join('');
 if(digest!==source.sha256)throw Error('The attachment does not match its verified source. Reopen the email.');
 signal.throwIfAborted();await validate();await destination.assertCurrent();signal.throwIfAborted();
 const reference=await uploadWorkspaceAttachment(destination.client,destination.workspaceId,file),stored=parseWorkspaceAttachmentMention(reference);if(!stored)throw Error('Attachment copy is unavailable.');
 // An interrupted workspace write may leave the explicitly requested copy, but never stages/sends a chat turn.
 signal.throwIfAborted();await validate();await destination.assertCurrent();signal.throwIfAborted();
 const provenance=new TextEncoder().encode(JSON.stringify({version:1,source,copyPath:stored.path,returnToMail:mailSourceHref(source)},null,2));
 const written=await destination.client.writeWorkspaceBinaryFile(destination.workspaceId,{path:stored.path+'.mail-source.json',data:provenance.buffer});if(!written.ok)throw Error('The attachment was copied, but source details could not be saved. Retry before adding it to chat.');
 signal.throwIfAborted();await validate();await destination.assertCurrent();signal.throwIfAborted();
 const state=useComposerStateStore.getState(),draft=getComposerDraft(state,destination.sessionId),mentions=getComposerMentions(state,destination.sessionId),text=`${draft}${draft?'\n\n':''}@${encodeComposerMentionValue(reference)}\n[Source email](${mailSourceHref(source)})`;
 state.setDraft(destination.sessionId,text);state.setMentions(destination.sessionId,{...mentions,[reference]:'upload'});useMailChatSources.getState().remember(destination.sessionId,source);destination.open();return{path:stored.path,sessionId:destination.sessionId};
}
