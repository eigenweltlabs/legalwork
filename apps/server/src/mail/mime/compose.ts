import { randomUUID } from 'node:crypto';
import { mailDraftContentSchema, mailAddressSchema, type MailDraftView } from '../local-view.js';
export type MailComposeContent = MailDraftView['content'];
export const MAIL_ATTACHMENT_LIMIT = 10 * 1024 * 1024;
export const MAIL_MESSAGE_LIMIT = 30 * 1024 * 1024;
const crlf = (text: string) => text.replace(/\r\n|\r|\n/g, '\r\n');
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
const encoded = (value: string) => Array.from(value).reduce<string[]>((chunks, char) => { if (!chunks.length || Buffer.byteLength(chunks[chunks.length-1]+char)>42) chunks.push(char); else chunks[chunks.length-1]+=char; return chunks; }, []).map(chunk => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ');
const textPart = (type: string, text: string) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(Buffer.from(crlf(text)))}`;
const multipart = (kind: string, parts: string[], boundary: string) => `Content-Type: multipart/${kind}; boundary="${boundary}"\r\n\r\n${parts.map(part=>`--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--`;
/** Provider-neutral bytes and separate envelope. Dispatch must pin the draft version,
 * supply account-authorized senders, and read verified immutable attachment bytes. */
export async function buildMailMime(content: MailComposeContent, options: {
 authorizedSenders: readonly string[];
 attachment: (part: MailComposeContent['attachments'][number], ordinal: number) => Promise<Uint8Array>;
 messageId?: string; date?: Date;
}): Promise<{raw:Uint8Array;envelope:{from:string;to:string[]};messageId:string;requiresSmtpUtf8:boolean;requires8BitMime:boolean}> {
 // This serializer supports ASCII mailbox/header identifiers; Unicode display content
 // is encoded separately. Never truncate an SMTPUTF8 mailbox through the byte-string path.
 if([content.from??'',...content.to,...content.cc,...content.bcc].some(value=>/[^\x00-\x7f]/.test(value)))throw Error('SMTPUTF8 mailbox addresses are not supported. Use an ASCII mailbox address.');
 if([content.inReplyTo??'',...content.references,options.messageId??''].some(value=>/[^\x00-\x7f]/.test(value)))throw Error('Message identifiers must contain ASCII characters only.');
 const draft=mailDraftContentSchema.parse(content),from=mailAddressSchema.parse(draft.from);
 if(draft.editor){for(const field of ['to','cc','bcc']){const text=field==='to'?draft.editor.to:field==='cc'?draft.editor.cc:draft.editor.bcc,expected=field==='to'?draft.to:field==='cc'?draft.cc:draft.bcc;
  const values=text.split(/[,;]/).filter(value=>value.trim()).map(value=>(value.match(/<([^<>]+)>/)?.[1]??value).trim());if(values.some(value=>!mailAddressSchema.safeParse(value).success)||JSON.stringify(values)!==JSON.stringify(expected))throw Error('Complete every recipient address before sending.');}
  if(draft.editor.from!==from)throw Error('Complete the sender address before sending.');}

 if(!options.authorizedSenders.some(sender=>sender.toLowerCase()===from.toLowerCase()))throw Error('The sender is not authorized for this account.');
 const recipients=[...new Map([...draft.to,...draft.cc,...draft.bcc].map(value=>[value.toLowerCase(),value])).values()];
 if(!recipients.length)throw Error('Add at least one recipient.');
 const messageId=options.messageId??`<${randomUUID()}@legalwork.local>`;
 if(!/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId))throw Error('Invalid message ID.');
 const date=options.date??new Date();if(!Number.isFinite(date.getTime()))throw Error('Invalid message date.');
 const boundaries=Array.from({length:3},()=>`=_legalwork_${randomUUID()}`);
 let body=draft.html===null?textPart('text/plain',draft.text):multipart('alternative',[textPart('text/plain',draft.text),textPart('text/html',draft.html)],boundaries[0]);
 const inline:string[]=[],attachments:string[]=[];let total=0;const ids=new Set<string>();
 for(const [index,part] of draft.attachments.entries()){
  const bytes=await options.attachment(part,index);total+=bytes.byteLength;
  if(bytes.byteLength>MAIL_ATTACHMENT_LIMIT||total>20*1024*1024)throw Error('Attachments exceed the message limit.');
  if(!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(part.contentType))throw Error('Invalid attachment media type.');
  const isInline=part.disposition==='inline';if(isInline&&(!part.contentId||ids.has(part.contentId)||!/^image\/(png|jpeg|gif|webp)$/.test(part.contentType)))throw Error('Inline images require a unique content ID and a supported image type.');if(part.contentId)ids.add(part.contentId);
  const name=Array.from(Buffer.from(part.filename),byte=>'%'+byte.toString(16).padStart(2,'0')).join('').match(/.{1,45}/g)??[''];
  const disposition=`Content-Disposition: ${isInline?'inline':'attachment'};\r\n ${name.map((chunk,i)=>`filename*${i}*=${i===0?"UTF-8''":''}${chunk}`).join(';\r\n ')}`;
  const rawMessage=part.contentType.toLowerCase()==='message/rfc822';
  let data=rawMessage?Buffer.from(bytes).toString('latin1'):base64(bytes);
  if(rawMessage){const separator=/\r?\n\r?\n/.exec(data),split=separator?.index??-1;if(split<0)throw Error('The attached message has no MIME headers.');data=crlf(data.slice(0,split)).replace(/^bcc:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*\r?\n?/gim,'')+'\r\n\r\n'+data.slice(split+(separator?.[0].length??4));}
  const value=`Content-Type: ${part.contentType}\r\n${disposition}\r\n${isInline?`Content-ID: <${part.contentId}>\r\n`:''}Content-Transfer-Encoding: ${rawMessage?'8bit':'base64'}\r\n\r\n${data}`;
  (isInline?inline:attachments).push(value);
 }
 if(inline.length)body=multipart('related',[body,...inline],boundaries[1]);
 if(attachments.length)body=multipart('mixed',[body,...attachments],boundaries[2]);
 const headers=[`From: ${from}`,...(draft.to.length?[`To: ${draft.to.join(',\r\n ')}`]:[]),...(draft.cc.length?[`Cc: ${draft.cc.join(',\r\n ')}`]:[]),`Subject: ${encoded(draft.subject)}`,`Date: ${date.toUTCString()}`,`Message-ID: ${messageId}`,...(draft.inReplyTo?[`In-Reply-To: ${draft.inReplyTo}`]:[]),...(draft.references.length?[`References: ${draft.references.join('\r\n ')}`]:[]),'MIME-Version: 1.0'];
 const raw=Buffer.from(headers.join('\r\n')+'\r\n'+body+'\r\n','latin1');if(raw.length>MAIL_MESSAGE_LIMIT)throw Error('The encoded message exceeds 30 MiB.');
 return{raw,envelope:{from,to:recipients},messageId,requiresSmtpUtf8:false,requires8BitMime:raw.some(byte=>byte>127)};
}
