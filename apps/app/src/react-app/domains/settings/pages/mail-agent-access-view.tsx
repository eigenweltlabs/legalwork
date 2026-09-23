/** @jsxImportSource react */
import {useEffect,useState} from 'react';
import {z} from 'zod';
import {Button} from '@/components/ui/button';
import {mailAccountPolicySchema,mailActionLabels,type MailAccountPolicy} from '../../../../../../server/src/mail/account-policy';
import {agentPermissionSchema} from '../../../../../../server/src/mail/agent-view';
import {MailClient,type MailAccountView} from '../../mail/mail-client';
import {MailSettingsSelect,MailSettingsSection} from './mail-settings-controls';
import {SettingsNotice} from '../settings-section';
const response=z.object({policy:mailAccountPolicySchema});
export function MailAgentAccessView({client,accounts}:{client:MailClient;accounts:MailAccountView[]}){
 const [account,setAccount]=useState(''),[policy,setPolicy]=useState<MailAccountPolicy>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[revision,setRevision]=useState(0);
 const selected=accounts.find(item=>item.id===(account||accounts[0]?.id));
 useEffect(()=>{setPolicy(undefined);setError('');setSaved(false);if(!selected)return;const controller=new AbortController();void client.request('/agent-policy',response,controller.signal,{action:'get',accountId:selected.id}).then(result=>{if(!controller.signal.aborted)setPolicy(result.policy);}).catch(()=>{if(!controller.signal.aborted)setError('Account policy could not be loaded.');});return()=>controller.abort();},[client,selected?.id,revision]);
 return <MailSettingsSection title="Agent mail permissions" description="Choose what agents can do with each account. The same settings apply in every chat; approval requests appear in the chat that requested the action.">
  {accounts.length?<><MailSettingsSelect aria-label="Mail policy account" value={selected?.id??''} disabled={busy} onChange={value=>{setAccount(value);setPolicy(undefined);}}>{accounts.map(item=><option key={item.id} value={item.id}>{item.displayName} · {item.provider}</option>)}</MailSettingsSelect>
  <p className="text-xs text-muted-foreground">Mail used in a chat may be processed by that chat’s configured model.</p>
  {policy?.migrationRequired&&<SettingsNotice>Earlier access was limited to particular workspaces or matters. All actions remain blocked until you save your choice for this account. Saving applies to every chat.</SettingsNotice>}
  {policy&&<><div className="divide-y divide-subtle">{agentPermissionSchema.options.filter(action=>selected?.provider!=='archive'||['search','read','attachments','export'].includes(action)).map(action=><div key={action} className="flex items-center justify-between gap-4 py-2"><span className="text-sm">{mailActionLabels[action]}</span><div className="w-40 shrink-0"><MailSettingsSelect aria-label={mailActionLabels[action]} disabled={busy} value={policy.actions[action]} onChange={value=>{if(value==='allow'||value==='ask'||value==='deny'){setPolicy({...policy,actions:{...policy.actions,[action]:value}});setSaved(false);}}}><option value="allow">Allow</option><option value="ask">Ask each time</option><option value="deny">Block</option></MailSettingsSelect></div></div>)}</div>
  <Button disabled={busy} variant="outline" onClick={()=>{setBusy(true);setError('');setSaved(false);void client.request('/agent-policy',response,new AbortController().signal,{action:'set',accountId:policy.accountId,expectedRevision:policy.revision,actions:policy.actions}).then(result=>{setPolicy(result.policy);setSaved(true);}).catch(()=>setError('Policy changed or could not be saved. Reload the policy and try again.')).finally(()=>setBusy(false));}}>Save account permissions</Button>{saved&&<p role="status" className="text-xs text-muted-foreground">Saved for every chat.</p>}</>}
  </>:<p className="text-sm text-muted-foreground">Connect a mail account to configure its agent permissions.</p>}
  {error&&<div className="space-y-2"><p role="alert" className="text-xs">{error}</p><Button variant="outline" size="sm" disabled={busy} onClick={()=>setRevision(value=>value+1)}>Reload policy</Button></div>}
 </MailSettingsSection>;
}
