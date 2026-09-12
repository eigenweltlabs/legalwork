/** @jsxImportSource react */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { MailClient, type MailAccountView } from '../../mail/mail-client';

export function GraphMailboxesView({client,accounts,onChanged}:{client:MailClient;accounts:MailAccountView[];onChanged:()=>void}) {
 const parents=accounts.filter(account=>account.provider==='graph'&&!account.personal&&!account.identity);
 const [parent,setParent]=useState(''),[address,setAddress]=useState(''),[kind,setKind]=useState<'shared'|'delegated'>('shared'),[write,setWrite]=useState(false),[send,setSend]=useState<'none'|'send_as'|'send_on_behalf'>('none'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{if(!parents.some(account=>account.id===parent))setParent(parents[0]?.id??'');},[accounts,parent]);
 const shared=accounts.filter(account=>account.identity);
 if(!parents.length&&!shared.length)return null;
 return <section className="space-y-3" aria-label="Microsoft shared and delegated mailboxes">
  <h3 className="text-sm font-medium">Microsoft shared and delegated mailboxes</h3>
  <p className="text-xs text-muted-foreground">Enter the mailbox address supplied by your administrator. Microsoft does not provide a list of mailboxes you may send from. Read access does not grant permission to send.</p>
  {shared.map(account=>{const identity=account.identity!;return <div key={account.id} className="rounded-md border p-3 text-sm space-y-2">
   <p>{identity.address} · {identity.kind} · {identity.state}</p>
   <p className="text-xs text-muted-foreground">Read: {identity.read?'available':'unavailable'} · Write: {identity.write?'administrator confirmed':'not available'} · Send as: {identity.sendAs?'administrator confirmed':'not available'} · Send on behalf: {identity.sendOnBehalf?'administrator confirmed':'not available'}</p>
   {!!identity.missingGrants.length&&<p className="text-xs">Required grants: {identity.missingGrants.join(', ')}. Ask your administrator, then reconnect the signed-in Microsoft account if additional app consent is needed.</p>}
   <p className="text-xs text-muted-foreground">Sent messages are saved in the signed-in account’s Sent Items. Exchange may also keep a shared-mailbox copy. Exchange determines the final sender identity.</p>
   <Button variant="outline" size="sm" disabled={busy} onClick={()=>{setParent(identity.credentialAccountId);setAddress(identity.address);setKind(identity.kind);setWrite(identity.writeConfirmed);setSend(identity.sendMode);setMessage('Review the administrator grants, then verify mailbox access.');}}>Review access</Button>
  </div>;})}
  {!!parents.length&&<form className="space-y-3" onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');setMessage('');try{await client.configureGraphMailbox({credentialAccountId:parent,address,kind,writeConfirmed:write,sendMode:send},new AbortController().signal);setMessage('Mailbox access verified. Synchronization starts independently of your other mailboxes.');onChanged();}catch{setError('Mailbox access could not be verified. Check the address, Exchange mailbox access, and Microsoft shared-mail permissions. Reconnect the signed-in Microsoft account after administrator consent, then retry.');}finally{setBusy(false);}}}>
   <label className="block text-sm">Signed-in Microsoft account<select className="mt-1 block w-full rounded-md border bg-background p-2" aria-label="Signed-in Microsoft account" value={parent} disabled={busy} onChange={event=>setParent(event.target.value)}>{parents.map(account=><option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>
   <label className="block text-sm">Mailbox address<input className="mt-1 block w-full rounded-md border bg-background p-2" type="email" required aria-label="Shared mailbox address" value={address} disabled={busy} onChange={event=>setAddress(event.target.value)} /></label>
   <label className="block text-sm">Mailbox type<select className="mt-1 block w-full rounded-md border bg-background p-2" aria-label="Mailbox type" value={kind} disabled={busy} onChange={event=>setKind(event.target.value==='delegated'?'delegated':'shared')}><option value="shared">Shared mailbox</option><option value="delegated">Delegated mailbox</option></select></label>
   <div className="flex items-center justify-between text-sm gap-3"><span>Administrator confirmed write access</span><Switch aria-label="Administrator confirmed write access" checked={write} disabled={busy} onCheckedChange={setWrite}/></div>
   <label className="block text-sm">Administrator-confirmed sender permission<select className="mt-1 block w-full rounded-md border bg-background p-2" aria-label="Administrator-confirmed sender permission" value={send} disabled={busy} onChange={event=>setSend(event.target.value==='send_as'?'send_as':event.target.value==='send_on_behalf'?'send_on_behalf':'none')}><option value="none">None / unknown</option><option value="send_as">Send as</option><option value="send_on_behalf">Send on behalf</option></select></label>
   <p className="text-xs text-muted-foreground">Only select rights your administrator has confirmed. These declarations are not a permission check; Microsoft verifies the actual rights on each operation.</p>
   <Button type="submit" variant="outline" disabled={busy||!parent}>{busy?'Verifying access…':'Verify mailbox access'}</Button>
  </form>}
  {error&&<p role="alert" className="text-sm">{error}</p>}{message&&<p role="status" className="text-sm">{message}</p>}
 </section>;
}
