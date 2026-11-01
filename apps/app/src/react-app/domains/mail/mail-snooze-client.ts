import { mailSnoozeSchema, mailSnoozeSetSchema, type MailSnooze } from '../../../../../server/src/mail/snooze-view';
import type { MailTime } from '../../../../../server/src/mail/scheduling-view';
import { MailClient, type MailMessageView } from './mail-client';

function checked(item:MailMessageView,result:MailSnooze){
  if(result.accountId!==item.accountId||JSON.stringify(result.locator)!==JSON.stringify(item.locator))throw Error('Snooze account changed.');
  return result;
}
export async function readMailSnooze(client:MailClient,item:MailMessageView,signal:AbortSignal){
  return checked(item,await client.request(`/accounts/${encodeURIComponent(item.accountId)}/messages/snooze/read`,mailSnoozeSchema,signal,{locator:item.locator}));
}
export async function setMailSnooze(client:MailClient,item:MailMessageView,state:MailSnooze,time:MailTime|null,signal:AbortSignal){
  checked(item,state);
  const input=mailSnoozeSetSchema.parse({locator:item.locator,expected:state.version,time});
  return checked(item,await client.request(`/accounts/${encodeURIComponent(item.accountId)}/messages/snooze/set`,mailSnoozeSchema,signal,input));
}
