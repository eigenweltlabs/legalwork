/** @jsxImportSource react */
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {resolveLegalworkConnection} from '@/react-app/shell/legalwork-connection';
import {MailClient} from '../../mail/mail-client';
import {mailPendingApprovalSchema,type MailPendingApproval} from '../../../../../../server/src/mail/account-policy';
import {PermissionApprovalPanel} from './permission-approval-modal';
const resultSchema=z.object({items:z.array(mailPendingApprovalSchema)});

async function localMailClient(){
 const connection=await resolveLegalworkConnection();if(!connection.resolvedHostToken)throw Error('No local mail connection');return new MailClient(connection.normalizedBaseUrl,connection.resolvedHostToken);
}
export function useMailApprovals(sessionId:string,enabled:boolean,loadClient:()=>Promise<MailClient>=localMailClient){
 const [pending,setPending]=useState<MailPendingApproval[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const current=useRef<{controller:AbortController;client?:MailClient;revision:number}|undefined>(undefined);
 useEffect(()=>{
  setPending([]);setBusy(false);setError('');if(!enabled)return;
  const state:{controller:AbortController;client?:MailClient;revision:number}={controller:new AbortController(),revision:0};current.current=state;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const live=()=>current.current===state&&!state.controller.signal.aborted;
  async function poll(){
   const revision=state.revision;
   try{
    if(!state.client){state.client=await loadClient();if(!live())return;}
    const result=await state.client.request('/agent-approvals',resultSchema,state.controller.signal,{sessionId});
    if(live()&&revision===state.revision)setPending(result.items);
   }catch{if(live()&&revision===state.revision)setPending([]);}
   finally{if(live())timer=setTimeout(()=>void poll(),1000);}
  }
  const reconnect=()=>{state.client=undefined;state.revision++;setPending([]);};
  window.addEventListener('legalwork-server-settings-changed',reconnect);
  void poll();return()=>{state.controller.abort();clearTimeout(timer);if(current.current===state)current.current=undefined;window.removeEventListener('legalwork-server-settings-changed',reconnect);};
 },[sessionId,enabled,loadClient]);
 const request=pending[0];
 function respond(allow:boolean){
  const state=current.current;if(!state?.client||!request)return;
  state.revision++;setBusy(true);setError('');
  void state.client.request('/agent-approvals',resultSchema,state.controller.signal,{sessionId,id:request.id,allow}).then(result=>{if(current.current===state&&!state.controller.signal.aborted)setPending(result.items);}).catch(()=>{if(current.current===state&&!state.controller.signal.aborted){setPending([]);setError('This approval changed or expired. Wait for the current request before trying again.');}}).finally(()=>{if(current.current===state&&!state.controller.signal.aborted)setBusy(false);});
 }
 return{request,busy,error,respond};
}
export function MailApprovalPanel({state}:{state:ReturnType<typeof useMailApprovals>}){
 return <>{state.request&&<MailApprovalRequest request={state.request} busy={state.busy} respond={state.respond}/ >}{state.error&&<p role="alert" className="px-4 py-2 text-xs">{state.error}</p>}</>;
}
export function MailApprovalRequest({request,busy,respond}:{request:MailPendingApproval;busy:boolean;respond:(allow:boolean)=>void}){
 return <PermissionApprovalPanel reviewDetails={request.description} allowForSession={false} busy={busy} permission={{id:request.id,sessionID:request.sessionId,permission:request.action,patterns:[request.accountLabel],always:[],metadata:{},receivedAt:request.createdAt,protocol:'legacy'}} respondPermission={(_id,reply)=>respond(reply==='once')}/>;
}
