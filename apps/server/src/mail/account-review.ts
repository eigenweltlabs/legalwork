import {mailDraftViewSchema} from './local-view.js';
import {mailMessageViewSchema} from './read-view.js';
export function mailReviewDescription(account:string,detail:unknown){
 const draft=mailDraftViewSchema.safeParse(detail);
 if(draft.success){const content=draft.data.content;return[
  `Account: ${account}`,`From: ${content.from}`,`To: ${content.to.join(', ')||'None'}`,`Cc: ${content.cc.join(', ')||'None'}`,`Bcc: ${content.bcc.join(', ')||'None'}`,
  `Subject: ${content.subject}`,`Attachments: ${content.attachments.map(part=>part.filename+' ('+(part.bytes??'unknown')+' bytes)').join(', ')||'None'}`,'',content.text,
 ].join('\n');}
 const message=mailMessageViewSchema.parse(detail);
 return[`Account: ${account}`,`From: ${message.metadata?.from??'Unknown sender'}`,`Subject: ${message.subject}`,`Date: ${message.metadata?.date??'Unknown date'}`,`Message: ${message.rfcMessageId??message.key}`,'','Move this message to Trash. It will not be permanently deleted.'].join('\n');
}
