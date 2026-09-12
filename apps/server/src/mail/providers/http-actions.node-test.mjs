import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MailHttpActions} from './http-actions.js';
import {gmailMutationPrecondition,graphMutationPrecondition,folderMutationPrecondition} from '../storage/mutation-precondition.js';
const signal=new AbortController().signal;
function gmail(labels=['INBOX','UNREAD'],scopes=['https://www.googleapis.com/auth/gmail.modify']) {
 const state={labels:[...labels],requests:[],dispatches:0,failRead:false,reject:false};
 const transport=new MailHttpActions({provider:'gmail',accessToken:'synthetic',grantedScopes:scopes,fetch:async(url,init)=>{
  assert.ok(url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/'));assert.equal(init.redirect,'error');state.requests.push({url,method:init.method,body:init.body&&JSON.parse(init.body)});
  if(init.method==='GET'){if(state.failRead&&state.dispatches)return new Response('',{status:503});if(url.endsWith('/labels'))return Response.json({labels:[{id:'INBOX'},{id:'UNREAD'},{id:'work'}]});return Response.json({id:'one',labelIds:state.labels});}
  assert.equal(state.dispatches,1,'journal must dispatch before network write');if(state.reject)return new Response('',{status:403});
  if(init.method==='DELETE')return new Response(null,{status:204});
  if(url.endsWith('/trash'))state.labels=[...state.labels.filter(v=>v!=='INBOX'),'TRASH'];
  else {const body=JSON.parse(init.body);state.labels=[...new Set([...state.labels.filter(v=>!body.removeLabelIds.includes(v)),...body.addLabelIds])];}
  return Response.json({id:'one',labelIds:state.labels});
 }});
 return {...state,state,run:change=>transport.mutate({replayKey:'test',locator:{provider:'gmail',messageId:'one'},precondition:gmailMutationPrecondition(labels),change},signal,()=>state.dispatches++)};
}
test('Gmail read/flag/archive/trash/labels preserve unrelated labels and dispatch once',async()=>{
 for(const [change,expected] of [[{kind:'read',read:true},['INBOX','work']],[{kind:'flags',add:['\\Flagged'],remove:[]},['INBOX','UNREAD','work','STARRED']],[{kind:'special',operation:'archive'},['UNREAD','work']],[{kind:'special',operation:'trash'},['UNREAD','work','TRASH']],[{kind:'memberships',add:[],remove:['work']},['INBOX','UNREAD']]]){
  const f=gmail(['INBOX','UNREAD','work']);assert.equal(await f.run(change),'confirmed');assert.deepEqual(f.state.labels,expected);assert.equal(f.state.dispatches,1);
 }
});
test('Gmail checks current labels and permanent delete scope before dispatch; lost post-write verification is uncertain',async()=>{
 const changed=gmail();changed.state.labels=['INBOX'];assert.equal(await changed.run({kind:'read',read:true}),'conflict');assert.equal(changed.state.dispatches,0);
 const denied=gmail();assert.equal(await denied.run({kind:'delete'}),'unsupported');assert.equal(denied.state.requests.length,0);
 const full=gmail(['INBOX'],['https://mail.google.com/']);assert.equal(await full.run({kind:'delete'}),'confirmed');assert.equal(full.state.requests.at(-1).method,'DELETE');
 const lost=gmail();lost.state.failRead=true;assert.equal(await lost.run({kind:'read',read:true}),'unknown');assert.equal(lost.state.dispatches,1);
});
test('Graph immutable moves, read flags, copies and delegated writes use exact mailbox scope',async()=>{
 for(const change of [{kind:'read',read:true},{kind:'flags',add:['\\Flagged'],remove:[]},{kind:'special',operation:'trash'},{kind:'copy',destination:'folder'}]){
  const state={id:'immutable-one',changeKey:'before',parentFolderId:'inbox-id',isRead:false,flag:{flagStatus:'notFlagged'}};let writes=0,dispatches=0;
  const transport=new MailHttpActions({provider:'graph',accessToken:'synthetic',mailboxAddress:'shared@example.test',grantedScopes:['Mail.ReadWrite.Shared'],fetch:async(url,init)=>{
   assert.ok(url.startsWith('https://graph.microsoft.com/v1.0/users/shared%40example.test/'));assert.equal(init.headers.Prefer,'IdType="ImmutableId"');
   if(init.method==='GET')return Response.json(url.includes('/mailFolders/')?{id:'destination-id'}:state);
   assert.equal(dispatches,1);writes++;const body=JSON.parse(init.body);Object.assign(state,body,{changeKey:'after'});if(body.destinationId)state.parentFolderId=body.destinationId;
   return Response.json({...state,...(url.endsWith('/copy')?{id:'copy-id'}:{})});
  }});
  assert.equal(await transport.mutate({replayKey:'test',locator:{provider:'graph',messageId:'immutable-one'},precondition:graphMutationPrecondition('before'),change},signal,()=>dispatches++),'confirmed');assert.equal(writes,1);
 }
});
test('Graph stale change keys, read-only and shared read/write grants never confer primary writes',async()=>{
 let writes=0;const input={replayKey:'test',locator:{provider:'graph',messageId:'one'},precondition:graphMutationPrecondition('old'),change:{kind:'read',read:true}};
 for(const scopes of [['Mail.Read'],['Mail.ReadWrite.Shared']]){const t=new MailHttpActions({provider:'graph',accessToken:'synthetic',grantedScopes:scopes,fetch:async()=>{writes++;throw Error();}});assert.equal(await t.mutate(input,signal,()=>writes++),'unsupported');}assert.equal(writes,0);
 const t=new MailHttpActions({provider:'graph',accessToken:'synthetic',grantedScopes:['Mail.ReadWrite'],fetch:async()=>Response.json({id:'one',changeKey:'new',parentFolderId:'folder',isRead:false})});assert.equal(await t.mutate(input,signal,()=>writes++),'conflict');assert.equal(writes,0);
});
test('Label rename uses remote identity and name precondition; system labels and nonempty Graph folder deletes never dispatch',async()=>{
 let writes=0;const g=new MailHttpActions({provider:'gmail',accessToken:'synthetic',grantedScopes:['https://www.googleapis.com/auth/gmail.modify'],fetch:async(url,init)=>{if(init.method==='GET')return Response.json({id:'label-id',name:'Old name',type:'user'});writes++;assert.deepEqual(JSON.parse(init.body),{name:'New name'});return Response.json({id:'label-id'});}});
 assert.equal(await g.mutate({replayKey:'rename',precondition:folderMutationPrecondition({name:'Old name',parentId:null}),change:{kind:'mailbox',operation:'rename',path:'label-id',destination:'New name'}},signal,()=>{}),'confirmed');assert.equal(writes,1);
 const t=new MailHttpActions({provider:'graph',accessToken:'synthetic',grantedScopes:['Mail.ReadWrite'],fetch:async()=>Response.json({id:'folder',displayName:'Name',parentFolderId:'root',totalItemCount:1,childFolderCount:0})});
 assert.equal(await t.mutate({replayKey:'delete-folder',precondition:folderMutationPrecondition({name:'Name',parentId:'root'}),change:{kind:'mailbox',operation:'delete',path:'folder'}},signal,()=>{throw Error('must not dispatch');}),'conflict');
});
