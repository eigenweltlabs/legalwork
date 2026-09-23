import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MailAgentAccessView} from '../../../src/react-app/domains/settings/pages/mail-agent-access-view';
import {MailApprovalPanel,useMailApprovals} from '../../../src/react-app/domains/session/chat/mail-approval-panel';
import {defaultMailAccountActions} from '../../../../server/src/mail/account-policy';
import {Button} from '../../../src/components/ui/button';

window.calls=[];
const policies={a:{accountId:'a',revision:0,migrationRequired:false,actions:{...defaultMailAccountActions}},b:{accountId:'b',revision:0,migrationRequired:true,actions:Object.fromEntries(Object.keys(defaultMailAccountActions).map(key=>[key,'deny']))}};
const approval=sessionId=>({id:'approval-'+sessionId,sessionId,workspaceId:'local',accountId:'a',accountLabel:'Personal · self@example.com',action:'Send mail',createdAt:Date.now(),description:`Account: Personal · self@example.com\nFrom: self@example.com\nTo: recipient@example.com\nCc: None\nBcc: hidden@example.com\nSubject: Exact synthetic subject (${sessionId})\nAttachments: None\n\nExact reviewed body\nSecond line is visible without opening details.`});
let pending={first:[approval('first')],second:[approval('second')]},delay=false,release;
const client={request:async(path,schema,signal,body)=>{
 window.calls.push(body);
 if(path==='/agent-policy'){
  if(body.action==='set')policies[body.accountId]={...policies[body.accountId],revision:policies[body.accountId].revision+1,migrationRequired:false,actions:body.actions};
  return{policy:policies[body.accountId]};
 }
 if(body.id){const old={items:[approval(body.sessionId)]};pending[body.sessionId]=[];if(delay){delay=false;return new Promise(resolve=>{release=()=>resolve(old);});}}
 return{items:pending[body.sessionId]??[]};
}};
const loadClient=async()=>client;
function Fixture(){
 const [session,setSession]=useState('first'),[remote,setRemote]=useState(false);
 const state=useMailApprovals(session,!remote,loadClient);
 return <main className="mx-auto max-w-3xl space-y-8 p-6"><MailAgentAccessView client={client} accounts={[{id:'a',provider:'gmail',displayName:'Personal · self@example.com'},{id:'b',provider:'graph',displayName:'Firm · lawyer@example.com'}]}/><section className="space-y-3 rounded-2xl border p-4"><h2>Chat {session}{remote?' (remote)':''}</h2><div className="flex flex-wrap gap-2"><Button onClick={()=>setSession('first')}>First chat</Button><Button onClick={()=>setSession('second')}>Second chat</Button><Button onClick={()=>{delay=true;}}>Delay next reply</Button><Button onClick={()=>release?.()}>Release old reply</Button><Button onClick={()=>setRemote(value=>!value)}>Toggle remote chat</Button></div><MailApprovalPanel state={state}/></section></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
