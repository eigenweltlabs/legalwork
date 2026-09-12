import type {SenderIdentity} from '../../../../../server/src/mail/sender-view';
import { mailDraftContentSchema, mailAddressSchema, type MailDraftView } from '../../../../../server/src/mail/local-view';
import type { MailMessageView } from './mail-client';
export type ComposeContent = MailDraftView['content'];
export type ComposeMode = 'reply'|'reply-all'|'forward'|'forward-attachment';
export function addresses(value: string): string[] {
 return value.split(/[,;]/).flatMap(part=>{const address=(part.match(/<([^<>]+)>/)?.[1]??part).trim();return mailAddressSchema.safeParse(address).success?[address]:[];});
}
export function emptyCompose(from: string): ComposeContent {return mailDraftContentSchema.parse({subject:'',to:[],text:'',from:mailAddressSchema.safeParse(from).success?from:null});}
export function replyCompose(item: MailMessageView, text:string, mode:ComposeMode, from:string, references:string[]=[]): ComposeContent {
 const content=emptyCompose(from),forward=mode.startsWith('forward'),self=from.toLowerCase();
 const unique=(values:string[])=>[...new Map(values.filter(value=>value.toLowerCase()!==self).map(value=>[value.toLowerCase(),value])).values()];
 content.subject=(forward?/^fwd?:/i:/^re:/i).test(item.subject)?item.subject:`${forward?'Fwd':'Re'}: ${item.subject}`;
 if(!forward){content.to=unique(addresses(item.metadata?.replyTo||item.metadata?.from||''));if(mode==='reply-all'){content.to=unique([...content.to,...addresses(item.metadata?.to??'')]);content.cc=unique(addresses(item.metadata?.cc??'')).filter(value=>!content.to.some(to=>to.toLowerCase()===value.toLowerCase()));}
  const id=item.metadata?.messageId??item.rfcMessageId;if(id&&/^<[^<>\s@]+@[^<>\s@]+>$/.test(id)){content.inReplyTo=id;content.references=[...new Set([...references,id])].slice(-40);}}
 content.text=mode==='forward-attachment'?'':`\n\n${forward?'---------- Forwarded message ----------':`On ${item.metadata?.date??'an earlier date'}, ${item.metadata?.from??'the sender'} wrote:`}\n${forward?`From: ${item.metadata?.from??''}\nTo: ${item.metadata?.to??''}\nDate: ${item.metadata?.date??''}\nSubject: ${item.subject}\n\n`:''}${forward?text:text.split('\n').map(line=>'> '+line).join('\n')}`;
 return content;
}
export function safeComposeHtml(source:string):string {
 const doc=new DOMParser().parseFromString(source,'text/html');
 for(const node of Array.from(doc.body.querySelectorAll('*'))){
  const cid=node.getAttribute('data-mail-cid');if(node.tagName==='IMG'&&cid&&/^[a-zA-Z0-9._@-]{1,200}$/.test(cid))node.setAttribute('src','cid:'+cid);
  if(['SCRIPT','STYLE','IFRAME','OBJECT','SVG','MATH','FORM','INPUT'].includes(node.tagName)){node.remove();continue;}
  if(!['P','DIV','BR','B','STRONG','I','EM','U','UL','OL','LI','BLOCKQUOTE','IMG','A'].includes(node.tagName)){node.replaceWith(...node.childNodes);continue;}
  for(const attribute of Array.from(node.attributes)){if(node.tagName==='DIV'&&attribute.name==='data-mail-signature'&&attribute.value==='true')continue;if(node.tagName==='IMG'&&attribute.name==='src'&&/^cid:[a-zA-Z0-9._@-]{1,200}$/.test(attribute.value))continue;if(node.tagName==='A'&&attribute.name==='href'&&/^https?:\/\//i.test(attribute.value))continue;node.removeAttribute(attribute.name);}
  if(node.tagName==='IMG'&&!node.hasAttribute('src'))node.remove();
 }
 return doc.body.innerHTML;
}

/** Preserve edited signatures; replace only an exact signature previously inserted by this editor. */
export function selectComposeSender(content:ComposeContent,identity:SenderIdentity,previousSignature=content.senderSignature):ComposeContent {
 const suffix=previousSignature?'\n\n-- \n'+previousSignature:'';
 let text=content.text;if(suffix&&text.endsWith(suffix))text=text.slice(0,-suffix.length);
 const signature=identity.signature?'\n\n-- \n'+identity.signature:'';
 const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\n','<br>');
 let html=content.html;
 if(html!==null){const old=previousSignature?'<div data-mail-signature="true">'+escape(suffix)+'</div>':'';if(old&&html.endsWith(old))html=html.slice(0,-old.length);if(signature)html+='<div data-mail-signature="true">'+escape(signature)+'</div>';}
 return {...content,senderIdentityId:identity.id,senderSignature:identity.signature,from:identity.address,text:text+signature,html,...(content.editor?{editor:{...content.editor,from:identity.address}}:{})};
}
export function defaultComposeSender(identities:SenderIdentity[],reply:boolean){return identities.find(value=>value.available&&(reply?value.defaultReply:value.defaultNew))??identities.find(value=>value.available);}

/** Mark only an exact inserted suffix when changing editor mode; edited signatures remain ordinary body. */
export function composeTextHtml(content:ComposeContent):string {
 const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\n','<br>');
 const suffix=content.senderSignature?'\n\n-- \n'+content.senderSignature:'';
 return suffix&&content.text.endsWith(suffix)?escape(content.text.slice(0,-suffix.length))+'<div data-mail-signature="true">'+escape(suffix)+'</div>':escape(content.text);
}
