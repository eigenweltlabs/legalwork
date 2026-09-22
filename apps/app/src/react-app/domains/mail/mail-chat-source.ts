import {z} from 'zod';
import {create} from 'zustand';
import {mailNotificationOpenSchema,mailNotificationTargetSchema} from '../../../../../server/src/mail/notification-view';
export const MAIL_SOURCE_OPEN_EVENT='legalwork-mail-source-open';
export const mailChatSourceSchema=mailNotificationOpenSchema.extend({accountLabel:z.string().max(512),subject:z.string().max(512),filename:z.string().max(512),referenceId:z.string().max(4096),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type MailChatSource=z.infer<typeof mailChatSourceSchema>;
export const mailSourceTargetSchema=mailNotificationTargetSchema.extend({referenceId:z.string().min(1).max(4096),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const prefix='/mail?source=';
export function mailSourceHref(source:MailChatSource){return prefix+encodeURIComponent(JSON.stringify(mailSourceTargetSchema.parse({accountId:source.accountId,locator:source.locator,referenceId:source.referenceId,sha256:source.sha256}))).replace(/[()]/g,value=>value==='('?'%28':'%29');}
/** A durable local locator, never a network authority. Current host custody is resolved by Mail. */
export function parseMailSourceHref(value:string){if(!value.startsWith(prefix)||value.length>24000)return null;try{return mailSourceTargetSchema.parse(JSON.parse(decodeURIComponent(value.slice(prefix.length))));}catch{return null;}}
export function openMailSource(value:string){const target=parseMailSourceHref(value);if(!target)return false;window.dispatchEvent(new CustomEvent(MAIL_SOURCE_OPEN_EVENT,{detail:target}));return true;}
/** Ephemeral composer affordance; durable provenance also accompanies the copied workspace file. */
export const useMailChatSources=create<{sessions:Record<string,MailChatSource>;remember:(id:string,source:MailChatSource)=>void}>(set=>({sessions:{},remember:(id,source)=>set(state=>({sessions:{...state.sessions,[id]:source}}))}));
