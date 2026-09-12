import {test,expect} from 'bun:test';
import {registerMailRoutes} from '../routes/mail.js';
import {matchRoute,type Route,type RequestContext} from '../routes/registry.js';
import {LocalMailService} from './service.js';
import {qualificationInputSchema} from './qualification-view.js';
// Route-only fixture supplies the fields read by the real handler.
function context(request:Request,params:Record<string,string>,host:boolean):RequestContext{return {request,url:new URL(request.url),params,actor:host?{type:'host'}:undefined} as RequestContext;}
test('qualification is host-only, strict, bounded and cancels a disconnected HTTP start',async()=>{
 const service=new LocalMailService({ownerId:'synthetic',databasePath:'/unused',loadKey:async()=>{throw Error('must not open');},executable:{kind:'node',path:process.execPath},entryPoint:'/unused'}),routes:Route[]=[],calls:string[]=[];
 const abort=new AbortController(),id='54f0d7af-73d9-4816-8662-3c648f855c90';
 service.qualification=async input=>{calls.push(input.action);if(input.action==='start')abort.abort();return{id,provider:'gmail',startedAt:1,finishedAt:null,state:'running',comparison:'pending',phase:'enumeration',maxMessages:2,sampleLimit:1,scope:'all_messages_including_spam_trash',providerMessages:0,localMessages:0,missingLocal:0,extraLocal:0,duplicateProviderIds:0,providerLabels:0,localLabels:0,missingLabels:0,extraLabels:0,membershipsChecked:0,membershipMismatches:0,rawSamples:0,rawMismatches:0,attachmentSamples:0,attachmentMismatches:0,bodySamples:0,bodyMismatches:0,incompleteSamples:0,skippedOversizeSamples:0,downloadedSampleBytes:0,providerStable:null,localStable:null,error:null};};
 registerMailRoutes(routes,'127.0.0.1',service);
 async function post(body:unknown,host=true,signal?:AbortSignal){const route=matchRoute(routes,'POST','/mail/v1/qualification');if(!route)throw Error('missing');return route.handler(context(new Request('http://127.0.0.1/mail/v1/qualification',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal}),route.params,host));}
 await expect(post({action:'start',accountId:'a'},false)).rejects.toMatchObject({status:401});
 for(const input of [{action:'start',accountId:'a',maxMessages:10001},{action:'start',accountId:'a',samples:21},{action:'start',accountId:'a',token:'private'},{action:'read',id:'invalid'}])await expect(post(input)).rejects.toMatchObject({status:400});
 expect(calls).toEqual([]);expect(qualificationInputSchema.parse({action:'start',accountId:'a'})).toMatchObject({maxMessages:2000,samples:10});
 const response=await post({action:'start',accountId:'a'},true,abort.signal);expect(response.headers.get('cache-control')).toBe('no-store');expect(calls).toEqual(['start','cancel']);
 const remote:Route[]=[];registerMailRoutes(remote,'0.0.0.0',service);expect(matchRoute(remote,'POST','/mail/v1/qualification')).toBeNull();
});
