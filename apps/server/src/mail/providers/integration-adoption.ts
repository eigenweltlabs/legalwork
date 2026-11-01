import { z } from "zod";
import type { MailDatabase } from "../storage/database-interface.js";
import { MailIntegrationAccounts } from "../storage/integrations.js";
import { MailCredentialRepository } from "../storage/credentials.js";
import type { MailIntegrationSnapshot } from "../integration-view.js";
import type { MailAccessCoordinator, MailAccountAccess } from "./access-coordinator.js";
import { mailProviderFetch } from "./integration-fetch.js";

async function profile(response: Response):Promise<unknown> {
  if(!response.ok){await response.body?.cancel();throw Error('mail_integration_identity_unavailable');}
  const reader=response.body?.getReader();if(!reader)throw Error('mail_integration_identity_unavailable');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>65536)throw Error('mail_integration_identity_unavailable');chunks.push(chunk.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  finally{await reader.cancel().catch(()=>{});}
}

/** Both identities come from authenticated provider responses, never a saved
 * display name or email address. Provider secrets stay inside the worker. */
export async function adoptMailIntegrations(database:MailDatabase,ownerId:string,snapshot:MailIntegrationSnapshot,options:{access?:MailAccessCoordinator;fetch?:typeof fetch;signal?:AbortSignal}={}) {
  const links=new MailIntegrationAccounts(database,ownerId),credentials=new MailCredentialRepository(database,ownerId),migrated:string[]=[];
  const signal=AbortSignal.any([AbortSignal.timeout(10_000),...(options.signal?[options.signal]:[])]);
  const stopped=new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(Error('mail_integration_identity_unavailable')),{once:true}));
  void stopped.catch(()=>{});
  for(const account of snapshot.accounts){
    const provider=account.connectorId==='gmail'?'gmail':'graph';
    for(const accountId of links.legacyAccounts(provider)){
      if(signal.aborted)return migrated;
      try{
        const binding=credentials.getBinding(accountId);
        let access:MailAccountAccess;
        try{access=credentials.readAccess(accountId,binding);}catch{if(!options.access)continue;access=await Promise.race([options.access.acquire(accountId),stopped]);}
        const response=await(options.fetch??mailProviderFetch)(provider==='gmail'?'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress':'https://graph.microsoft.com/v1.0/me?$select=id',{
          headers:{Authorization:`Bearer ${access.accessToken}`,Accept:'application/json'},redirect:'error',signal,
        });
        const value=await profile(response);
        const identity=provider==='gmail'?z.object({emailAddress:z.email()}).parse(value).emailAddress.toLowerCase():z.object({id:z.string().min(1)}).parse(value).id;
        if(signal.aborted||identity!==account.identity)continue;
        links.adopt(accountId,account,access.version);migrated.push(accountId);
      }catch{/* Unproven or stale identities retain their archive and credentials. */}
    }
  }
  return migrated;
}
