import {request as httpRequest} from 'node:http';
import {test} from 'node:test';import assert from 'node:assert/strict';import {serve} from '../serve-node.js';import {LocalMailService} from './service.js';
test('closing a slow maintenance HTTP request aborts the service and keeps its barrier until physical work ends',async()=>{
 let entered!:()=>void,aborted!:()=>void,release!:()=>void;
 const started=new Promise<void>(resolve=>entered=resolve),cancelled=new Promise<void>(resolve=>aborted=resolve),physical=new Promise<void>(resolve=>release=resolve);let promoted=false;
 const service=new LocalMailService({ownerId:'synthetic',databasePath:'/unused',loadKey:async()=>{throw Error('must not open');},executable:{kind:'node',path:process.execPath},entryPoint:'/unused',maintain:async(_operation,_passphrase,signal)=>{entered();await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>{aborted();resolve();},{once:true});});await physical;if(signal.aborted)throw Error('cancelled');promoted=true;}});
 let settled!:()=>void;const finished=new Promise<void>(resolve=>settled=resolve);
 const server=await serve({hostname:'127.0.0.1',port:0,idleTimeout:1,fetch:async request=>{await request.text();try{await service.maintain('backup','synthetic-passphrase',request.signal);return Response.json({completed:true});}catch{return Response.json({completed:false},{status:503});}finally{settled();}}});
 try{const request=httpRequest(`http://127.0.0.1:${server.port}/maintenance`,{method:'POST'});request.on('error',()=>{});request.end('synthetic');await started;request.destroy();await Promise.race([cancelled,new Promise((_,reject)=>setTimeout(()=>reject(Error('cancellation did not propagate')),2000))]);await assert.rejects(service.unlock(),/mail_locked/);assert.equal(promoted,false);release();await finished;assert.equal(promoted,false);}finally{release();await service.stop();await server.stop();}
});
