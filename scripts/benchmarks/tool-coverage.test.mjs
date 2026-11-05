import test from"node:test";import assert from"node:assert/strict";import{toolExecutionCoverage}from"./tool-coverage.mjs";
test("full tool results require exact owned execution identity and cannot borrow another session",()=>{
 const call={sessionID:"owned",messageID:"m",callID:"c",tool:"read",protocol:"native-v2",state:{status:"completed",input:{path:"a"}}};
 const record={phase:"after",sessionID:"owned",messageID:"m",id:"c",tool:"read",input:{path:"a"},status:"completed",result:{output:"full"},observerInstance:"observed",sequence:2};
 assert.equal(toolExecutionCoverage({tools:[call]},[record],["owned"]).complete,true);
 for(const changed of [{...record,sessionID:"other"},{...record,input:{path:"b"}},{...record,phase:"before"},{...record,result:undefined}])assert.equal(toolExecutionCoverage({tools:[call]},[changed],["owned"]).complete,false);
});
test("Code Mode fetch and denied calls stay explicit missing boundaries instead of invented outputs",()=>{
 const call={sessionID:"owned",messageID:"m",callID:"c",tool:"execute",protocol:"native-v2",state:{status:"completed",input:{code:"return null"},metadata:{toolCalls:[{tool:"fetch",input:{url:"https://example.invalid"},status:"completed"}]}}};
 const record={phase:"after",sessionID:"owned",messageID:"m",id:"c",tool:"execute",input:call.state.input,status:"completed",result:{output:null}};
 const result=toolExecutionCoverage({tools:[call]},[record],["owned"]);assert.equal(result.complete,false);assert.equal(result.missing[0].tool,"fetch");
 assert.equal(toolExecutionCoverage({tools:[{...call,tool:"denied",state:{status:"error",input:{}}}]},[],["owned"]).complete,false);
});


test("identical CodeMode calls match terminal status as a multiset, never reversed results or running rows",()=>{
 const input={same:true};const call={sessionID:"owned",messageID:"m",callID:"c",tool:"execute",protocol:"native-v2",state:{status:"completed",input:{code:"fixture"},metadata:{toolCalls:[{tool:"child",input,status:"completed"},{tool:"child",input,status:"error"}]}}};
 const root={phase:"after",sessionID:"owned",messageID:"m",id:"c",tool:"execute",input:call.state.input,status:"completed",result:{output:null}};
 const child={phase:"after",sessionID:"owned",messageID:"m",id:"c",tool:"child",input,pairing:"duplicate-concurrent-key-duration-unknown"};
 const result=toolExecutionCoverage({tools:[call]},[root,{...child,status:"error",error:{message:"failed"}},{...child,status:"completed",result:{output:{ok:true}}}],["owned"]);
 assert.equal(result.complete,true);assert.deepEqual(result.matched.slice(1).map(x=>x.status),["completed","error"]);assert.ok(result.matched.slice(1).every(x=>x.rowIdentity==="same-key-status-multiset-not-unique-child-id"));
 call.state.metadata.toolCalls[0].status="running";assert.equal(toolExecutionCoverage({tools:[call]},[root,{...child,status:"completed",result:{output:{ok:true}}}],["owned"]).complete,false);
});

test("V1 command-subtask correlation preserves source-backed part ID without guessing other hook IDs",()=>{
 const call={sessionID:"owned",messageID:"m",id:"part_exact",callID:"different_persisted_ulid",tool:"task",protocol:"legacy-v1",state:{status:"completed",input:{subagent_type:"legalwork",prompt:"controlled task"}}};
 const record={phase:"after",sessionID:"owned",id:"part_exact",tool:"task",input:call.state.input,status:"completed",result:{output:"actual task result"}};
 const matched=toolExecutionCoverage({tools:[call]},[record],["owned"]);assert.equal(matched.complete,true);assert.equal(matched.matched[0].observedCallID,"part_exact");assert.equal(matched.matched[0].callID,"different_persisted_ulid");
 for(const changed of [{...record,id:"unrelated_part"},{...record,result:undefined,status:"unavailable"},{...record,sessionID:"other"}])assert.equal(toolExecutionCoverage({tools:[call]},[changed],["owned","other"]).complete,false);
 assert.equal(toolExecutionCoverage({tools:[{...call,tool:"read"}]},[{...record,tool:"read"}],["owned"]).complete,false);
});

test("V1 exact BEFORE and full reported terminal failure complete only lifecycle-as-exposed, never raw returns",async()=>{
 const {reconcileToolTrace}=await import('./tool-coverage.mjs');
 const call={sessionID:"owned",messageID:"m",id:"part",callID:"c",tool:"read",protocol:"legacy-v1",state:{status:"error",input:{path:"protected"},error:"PermissionDenied: exact API text",time:{start:1,end:2},metadata:{preserved:true}}};
 const before={phase:"before",sessionID:"owned",id:"c",tool:"read",input:call.state.input,observerInstance:"observer",sequence:1,recordSha256:"actual-hash"};
 const coverage=toolExecutionCoverage({tools:[call]},[before],["owned"]);
 assert.equal(coverage.contractVersion,2);assert.equal(coverage.completeAsExposed,true);assert.equal(coverage.fullRawReturnCoverage,false);assert.equal(coverage.matched.length,0);
 const failure=coverage.unavailableFailureReturns[0];assert.deepEqual(failure.persistedState,call.state);assert.equal(failure.rawReturnAvailable,false);assert.equal(failure.durationMs,null);assert.equal(failure.errorStage,"not-exposed");assert.equal(failure.source.commit,"16747470f976aca3d362ad730bcd3fe82ecc2c9a");
 const trace={captureIntegrityVerified:true,complete:false,records:[before],pendingBefore:[before],afterWithoutBefore:[]};const reconciled=reconcileToolTrace(trace,coverage);assert.equal(reconciled.completeAsExposed,true);assert.equal(reconciled.fullRawReturnCoverage,false);assert.equal(reconcileToolTrace({...trace,captureIntegrityVerified:false},coverage).completeAsExposed,false);assert.equal(reconciled.rawJournalLifecycleComplete,false);assert.deepEqual(reconciled.rawPendingBefore,[before]);assert.equal(reconcileToolTrace({...trace,pendingBefore:[{...before,sequence:99}]},coverage).completeAsExposed,false);assert.equal(reconcileToolTrace({...trace,afterWithoutBefore:[{phase:"after"}]},coverage).completeAsExposed,false);
 for(const badCall of [{...call,protocol:"native-v2"},{...call,state:{...call.state,status:"running"}},{...call,state:{...call.state,status:"completed"}},{...call,state:{...call.state,error:""}},{...call,state:{status:"error",error:"missing input"}},{...call,state:{...call.state,input:null}}])assert.equal(toolExecutionCoverage({tools:[badCall]},[before],["owned"]).completeAsExposed,false);
 assert.equal(toolExecutionCoverage({tools:[call]},[],["owned"]).completeAsExposed,false);
 for(const changed of [{...before,sessionID:"other-owned"},{...before,id:"other-call"},{...before,tool:"grep"},{...before,input:{path:"different"}},{...before,messageID:"conflicting-explicit-message"},{...before,phase:"after"},{...before,observerInstance:""},{...before,sequence:0}])assert.equal(toolExecutionCoverage({tools:[call]},[changed],["owned","other-owned"]).completeAsExposed,false);
 const after={...before,phase:"after",sequence:2,status:"completed",result:{output:"contradictory completed value"}};assert.equal(toolExecutionCoverage({tools:[call]},[before,after],["owned"]).completeAsExposed,false);
 assert.equal(toolExecutionCoverage({tools:[call,call]},[before],["owned"]).completeAsExposed,false);
});

test("V1 command caught failure keeps actual unavailable AFTER and exact persisted part-ID identity",()=>{
 const call={sessionID:"owned",messageID:"m",id:"command_part",callID:"different_ulid",tool:"task",protocol:"legacy-v1",state:{status:"error",input:{prompt:"controlled"},error:"Actual caught task failure"}};
 const before={phase:"before",sessionID:"owned",id:"command_part",tool:"task",input:call.state.input,observerInstance:"observer",sequence:1};const after={...before,phase:"after",sequence:2,status:"unavailable",resultAvailability:"v1-after-hook-provided-no-value"};
 const observed=toolExecutionCoverage({tools:[call]},[before,after],["owned"]);assert.equal(observed.completeAsExposed,true);assert.equal(observed.fullRawReturnCoverage,false);assert.equal(observed.unavailableFailureReturns[0].observedCallID,"command_part");assert.equal(observed.unavailableFailureReturns[0].callID,"different_ulid");assert.equal(observed.unavailableFailureReturns[0].observedUnavailableAfter[0].sequence,2);assert.match(observed.unavailableFailureReturns[0].source.path,/prompt.ts/);assert.equal(after.status,"unavailable");assert.equal(Object.hasOwn(after,"result"),false);
 for(const wrong of [{...after,result:{output:"defined value"}},{...after,resultAvailability:"unknown"},{...after,status:"error"}])assert.equal(toolExecutionCoverage({tools:[call]},[before,wrong],["owned"]).completeAsExposed,false);
});

test("recoverable V1 error followed by success retains both real evidence forms without halting an ongoing task",async()=>{
 const {reconcileToolTrace}=await import('./tool-coverage.mjs');const failure={sessionID:"owned",messageID:"m",callID:"c1",tool:"read",protocol:"legacy-v1",state:{status:"error",input:{path:"missing"},error:"File not found"}};const success={...failure,callID:"c2",state:{status:"completed",input:{path:"found"},output:"Exact successful API output"}};
 const first={phase:"before",sessionID:"owned",id:"c1",tool:"read",input:failure.state.input,observerInstance:"observer",sequence:1};const second={...first,id:"c2",input:success.state.input,sequence:2};const after={...second,phase:"after",sequence:3,status:"completed",result:{output:"Full actual returned text"}};const records=[first,second,after];const coverage=toolExecutionCoverage({tools:[failure,success]},records,["owned"]);const completion=reconcileToolTrace({captureIntegrityVerified:true,complete:false,pendingBefore:[first],afterWithoutBefore:[]},coverage);assert.equal(completion.completeAsExposed,true);assert.equal(completion.fullRawReturnCoverage,false);assert.equal(coverage.matched.length,1);assert.equal(coverage.unavailableFailureReturns.length,1);assert.equal(records.length,3);assert.equal(records.filter(r=>r.phase==='after').length,1);
});

test("patched native fetch groups sanitized progress with complete private HTTP results without inventing child IDs",()=>{
 const input={method:"PATCH",url:"https://EXAMPLE.invalid/resource?q=1#section"};const call={sessionID:"owned",messageID:"m",callID:"parent",tool:"execute",protocol:"native-v2",state:{status:"completed",input:{code:"two actual HTTP calls"},metadata:{toolCalls:[{tool:"fetch",input,status:"completed"},{tool:"fetch",input,status:"error"}]}}};
 const root={phase:"after",sessionID:"owned",messageID:"m",id:"parent",tool:"execute",input:call.state.input,status:"completed",result:{output:"outer result"}};const transport={phase:"after",sessionID:"owned",messageID:"m",id:"parent",tool:"legalwork_raw_http",input:{method:"patch",url:"https://example.invalid/resource?q=1",headers:{authorization:"synthetic-private-header"},bodyBase64:"AAE="}};
 const failed={...transport,status:"error",error:{message:"actual transport failure"}};const succeeded={...transport,status:"completed",result:{output:{url:"https://example.invalid/resource?q=1",status:200,statusText:"OK",headers:{"content-type":"application/octet-stream"},bodyBase64:"AAE=",redirected:false}}};const records=[root,failed,succeeded];const coverage=toolExecutionCoverage({tools:[call]},records,["owned"]);assert.equal(coverage.completeAsExposed,true);assert.equal(coverage.fullRawReturnCoverage,true);assert.deepEqual(coverage.matched.slice(1).map(r=>r.status),["completed","error"]);assert.ok(coverage.matched.slice(1).every(r=>r.rowIdentity==='same-display-group-status-multiset-not-unique-extension-id'&&r.extensionCallID===null));assert.equal(coverage.matched[1].displayGroup.url,"https://example.invalid/resource?q=1");assert.equal(records[2].input.headers.authorization,"synthetic-private-header");assert.equal(records[2].result.output.bodyBase64,"AAE=");
 for(const changed of [{...succeeded,sessionID:"other-owned"},{...succeeded,messageID:"other-message"},{...succeeded,id:"other-parent"},{...succeeded,input:{...succeeded.input,method:"GET"}},{...succeeded,input:{...succeeded.input,url:"https://example.invalid/different"}},{...succeeded,result:undefined}])assert.equal(toolExecutionCoverage({tools:[call]},[root,failed,changed],["owned","other-owned"]).completeAsExposed,false);
 for(const local of ["data:text/plain,local","blob:https://example.invalid/id","file:///test-owned/forbidden"]){const changed={...call,state:{...call.state,metadata:{toolCalls:[{tool:"fetch",input:{method:"GET",url:local},status:"completed"}]}}};assert.equal(toolExecutionCoverage({tools:[changed]},[root,succeeded],["owned"]).completeAsExposed,false);}
});

test("native declined/Stop history accounts for genuine BEFORE-only lifecycles without inventing returned values", async()=>{
 const {reconcileToolTrace}=await import('./tool-coverage.mjs');
 const call={sessionID:'owned',messageID:'msg',callID:'native_canary_permission-deny',tool:'read',protocol:'native-v2',state:{status:'error',input:{path:'/home/legalwork/outside-native-canary.txt'},error:{type:'aborted',message:'The user declined this tool call'}}};
 const before={phase:'before',sessionID:'owned',messageID:'msg',id:call.callID,tool:'read',input:call.state.input,observerInstance:'actual-observer',sequence:1,recordSha256:'original'};
 const result=toolExecutionCoverage({tools:[call]},[before],['owned']);assert.equal(result.completeAsExposed,true);assert.equal(result.fullRawReturnCoverage,false);assert.equal(result.matched.length,0);assert.deepEqual(result.unavailableFailureReturns[0].persistedState,call.state);assert.equal(result.unavailableFailureReturns[0].durationMs,null);assert.equal(result.unavailableFailureReturns[0].rawReturnAvailable,false);
 assert.equal(reconcileToolTrace({captureIntegrityVerified:true,pendingBefore:[before],afterWithoutBefore:[],complete:false},result).completeAsExposed,true);
 for(const changed of [{...call,state:{...call.state,status:'completed'}},{...call,state:{...call.state,error:{type:'unknown',message:'The user declined this tool call'}}},{...call,state:{...call.state,error:{type:'aborted',message:'Unknown cancellation'}}},{...call,sessionID:'other'},{...call,messageID:'other'},{...call,state:{...call.state,input:{path:'other'}}}])assert.equal(toolExecutionCoverage({tools:[changed]},[before],['owned','other']).completeAsExposed,false);
 for(const changed of [{...before,messageID:undefined},{...before,messageID:'other'},{...before,id:'other'},{...before,tool:'grep'},{...before,sequence:0},{...before,observerInstance:''}])assert.equal(toolExecutionCoverage({tools:[call]},[changed],['owned']).completeAsExposed,false);
 assert.equal(toolExecutionCoverage({tools:[call]},[before],[]).completeAsExposed,false);
 for(const after of [{...before,phase:'after',status:'completed',result:{output:'conflict'}},{...before,phase:'after',status:'error'},{...before,phase:'after',status:'unavailable'},{...before,phase:'after',input:{path:'conflicting'},status:'error'}])assert.equal(toolExecutionCoverage({tools:[call]},[before,after],['owned']).completeAsExposed,false);
 const actual={...before,phase:'after',sequence:2,status:'error',error:call.state.error};assert.equal(toolExecutionCoverage({tools:[call]},[before,actual],['owned']).fullRawReturnCoverage,true);
 assert.equal(toolExecutionCoverage({tools:[call,call]},[before],['owned']).completeAsExposed,false);
});

test("native Stop Code Mode uses authoritative child mapping and exact parent context with raw input absence preserved",()=>{
 const call={sessionID:'owned',messageID:'msg',callID:'native_canary_mcp-stop',tool:'execute',protocol:'native-v2',state:{status:'error',input:{code:'return await tools.canary.hang({});'},error:{type:'aborted',message:'Tool execution interrupted'},metadata:{toolCalls:[{tool:'canary.hang',status:'error'}]}}};
 const root={phase:'before',sessionID:'owned',messageID:'msg',id:call.callID,tool:'execute',input:call.state.input,observerInstance:'native',sequence:1};const child={...root,tool:'canary_hang',input:{},sequence:2};const mapping=[{qualifiedName:'canary.hang',id:'canary_hang'}];
 const result=toolExecutionCoverage({tools:[call]},[root,child],['owned'],mapping);assert.equal(result.completeAsExposed,true);assert.equal(result.fullRawReturnCoverage,false);assert.equal(result.unavailableFailureReturns.length,2);assert.match(result.unavailableFailureReturns[1].inputAvailability,/absent/);assert.equal(Object.hasOwn(call.state.metadata.toolCalls[0],'input'),false);assert.deepEqual(child.input,{});
 for(const maps of [[],[...mapping,...mapping],[...mapping,{qualifiedName:'collision.other',id:'canary_hang'}],[{qualifiedName:'canary.hang',id:'other'}]])assert.equal(toolExecutionCoverage({tools:[call]},[root,child],['owned'],maps).completeAsExposed,false);
 for(const changed of [{...child,messageID:'wrong'},{...child,sessionID:'other'},{...child,id:'wrong'},{...child,tool:'canary_hang_suffix'}])assert.equal(toolExecutionCoverage({tools:[call]},[root,changed],['owned','other'],mapping).completeAsExposed,false);
 assert.equal(toolExecutionCoverage({tools:[call]},[root,child,{...child,sequence:3}],['owned'],mapping).completeAsExposed,false);
 const duplicated={...call,state:{...call.state,metadata:{toolCalls:[...call.state.metadata.toolCalls,...call.state.metadata.toolCalls]}}};assert.equal(toolExecutionCoverage({tools:[duplicated]},[root,child],['owned'],mapping).completeAsExposed,false);
 const unrelated={...call,state:{...call.state,error:{type:'tool.execution',message:'Tool execution interrupted'}}};assert.equal(toolExecutionCoverage({tools:[unrelated]},[root,child],['owned'],mapping).completeAsExposed,false);
});
