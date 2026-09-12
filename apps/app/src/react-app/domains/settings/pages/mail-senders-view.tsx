import {Checkbox} from '@/components/ui/checkbox';
import {Textarea} from '@/components/ui/textarea';
import {Input} from '@/components/ui/input';
import {MailSettingsSelect,MailSettingsSection} from './mail-settings-controls';
/** @jsxImportSource react */
import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {MailClient,type MailAccountView} from '../../mail/mail-client';
import type {SenderIdentity} from '../../../../../../server/src/mail/sender-view';
export function MailSendersView({client,accounts}:{client:MailClient;accounts:MailAccountView[]}){
 const [account,setAccount]=useState('');
 const selected=accounts.find(value=>value.id===account)??accounts[0];
 return <MailSettingsSection title="Sender identities and signatures">{selected?<><MailSettingsSelect aria-label="Identity account" className="w-full rounded border bg-background p-2 text-sm" value={selected.id} onChange={value =>setAccount(value)}>{accounts.map(value=><option value={value.id} key={value.id}>{value.displayName}</option>)}</MailSettingsSelect><AccountSenders key={selected.id} client={client} account={selected}/></>:<p className="text-xs text-muted-foreground">Connect an account to configure sender identities.</p>}</MailSettingsSection>;
}
function AccountSenders({client,account}:{client:MailClient;account:MailAccountView}){
 const [values,setValues]=useState<SenderIdentity[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[address,setAddress]=useState(''),[confirmed,setConfirmed]=useState(false);
 useEffect(()=>{const controller=new AbortController();void client.senders(account.id,controller.signal).then(values=>{if(!controller.signal.aborted)setValues(values);}).catch(()=>{if(!controller.signal.aborted)setError('Sender identities could not be loaded.');});return()=>controller.abort();},[client,account.id]);
 async function run(work:()=>Promise<SenderIdentity[]>){setBusy(true);setError('');try{setValues(await work());}catch{setError('Sender identities could not be updated. Check the account connection and permissions, then retry.');}finally{setBusy(false);}}
 return <div className="space-y-3">
 <p className="text-xs text-muted-foreground">{account.provider==='gmail'?'Refresh to discover verified Gmail send-as aliases. Add and verify aliases in Gmail Settings first.':account.provider==='graph'?'Microsoft offers the authenticated address and configured shared or delegated mailboxes. Exchange verifies administrator-confirmed sender rights when sending.':'IMAP cannot verify SMTP sender rights. Add only addresses your outgoing mail provider permits; delivery still requires SMTP acceptance.'}</p>
 <Button variant="outline" disabled={busy} onClick={()=>void run(()=>client.senders(account.id,new AbortController().signal,true))}>Refresh sender identities</Button>
 {account.provider==='imap'&&<div className="space-y-2"><Input aria-label="Permitted SMTP address" type="email" className="mt-1" value={address} onChange={event=>setAddress(event.target.value)} placeholder="name@example.com"/><label className="flex gap-2 text-xs"><Checkbox  checked={confirmed} onCheckedChange={checked =>setConfirmed(checked)}/>My outgoing mail provider permits this address.</label><Button variant="outline" disabled={busy||!confirmed||!address} onClick={()=>void run(()=>client.configureSender(account.id,{address,confirmed:true},new AbortController().signal))}>Add sender address</Button></div>}
 {values.map(value=><div key={value.id}><IdentitySettings key={value.id+':'+value.signature+':'+value.defaultNew+':'+value.defaultReply} value={value} busy={busy} save={input=>void run(()=>client.senderSettings(account.id,input,new AbortController().signal))}/>{account.provider==='imap'&&value.available&&<Button variant="outline" disabled={busy} onClick={()=>void run(()=>client.configureSender(account.id,{address:value.address,confirmed:true,remove:true},new AbortController().signal))}>Remove {value.address}</Button>}</div>)}
 {!values.length&&<p className="text-xs text-muted-foreground">No sender identities have been loaded. Refresh to check the provider.</p>}{error&&<p role="alert" className="text-xs">{error}</p>}
 </div>;
}
function IdentitySettings({value,busy,save}:{value:SenderIdentity;busy:boolean;save:(input:{identityId:string;signature:string;defaultNew:boolean;defaultReply:boolean})=>void}){
 const [signature,setSignature]=useState(value.signature),[defaultNew,setNew]=useState(value.defaultNew),[defaultReply,setReply]=useState(value.defaultReply);
 return <fieldset className="space-y-3 rounded-xl border border-subtle bg-background p-4" disabled={busy}><legend className="px-1 text-sm">{value.address}</legend><p className="text-xs text-muted-foreground">{value.available?'Available':'Unavailable'} · {value.source==='provider_verified'?'Provider verified':value.source==='administrator_confirmed'?'Administrator-confirmed permission':'User-confirmed SMTP address'}</p><label className="block text-xs">Signature<Textarea aria-label={`Signature for ${value.address}`} className="mt-1 min-h-24" maxLength={4000} value={signature} onChange={event=>setSignature(event.target.value)}/></label><div className="flex gap-4 text-xs"><label className="flex items-center gap-2"><Checkbox  checked={defaultNew} onCheckedChange={checked =>setNew(checked)}/> Default for new messages</label><label className="flex items-center gap-2"><Checkbox  checked={defaultReply} onCheckedChange={checked =>setReply(checked)}/> Default for replies</label></div><Button variant="outline" onClick={()=>save({identityId:value.id,signature,defaultNew,defaultReply})}>Save identity preferences</Button></fieldset>;
}
