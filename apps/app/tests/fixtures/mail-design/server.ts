import {createHash} from 'node:crypto';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const workspace={id:'matter-aster',name:'Aster · Commercial',displayName:'Aster · Commercial',path:'/synthetic/aster',preset:'starter',workspaceType:'local',opencode:{directory:'/synthetic/aster'}};
export const session={id:'ses_review',title:'Contract review',directory:'/synthetic/aster',projectID:'synthetic',version:'1',time:{created:1789200000000,updated:1789200000000}};
const attachment=Buffer.from('ASTER — CONTRACT REVIEW\n\nSynthetic agreement appendix.\nTerm: 24 months.\nNotice period: 60 days.\n');
const accounts=[{id:'gmail',provider:'gmail',displayName:'Mira Chen <mira@example.test>'},{id:'graph',provider:'graph',displayName:'Commercial team <commercial@example.test>'}];
const subjects=['Aster agreement · final comments','Updated closing checklist','Re: Aster acquisition — diligence','Board minutes for review','Signature pages · Thursday','Northwind licensing renewal','Tomorrow’s case conference','Revised fee estimate'];
export const messages=Array.from({length:2000},(_,index)=>{const account=index%4===3?'graph':'gmail',id='message-'+index,subject=subjects[index%subjects.length];return{accountId:account,key:JSON.stringify([account, id]),locator:account==='graph'?{provider:'graph',messageId:id}:{provider:'gmail',messageId:id},subject,threadId:index<3?'aster-thread':null,rfcMessageId:`<${id}@example.test>`,removed:false,memberships:['INBOX'],contentState:'complete',metadata:{subject,from:index%2?'Alex Morgan <alex@example.test>':'Nora Fischer <nora@example.test>',to:'Mira Chen <mira@example.test>',cc:null,bcc:null,replyTo:null,date:'Sat, 12 Sep 2026 10:00:00 +0200',messageId:`<${id}@example.test>`},receivedAt:1789200000000-index*1000000,rawReferenceId:'sha256:raw-synthetic',isRead:index%3!==0,isFlagged:index===2,mutationPrecondition:'synthetic-current'};});
const body=Buffer.from(JSON.stringify({version:1,bodies:[{partId:'plain',contentType:'text/plain',text:'Hi Mira,\n\nPlease review the final comments in the attached agreement. The revised notice period is highlighted in section 4.\n\nCould you confirm our position before tomorrow’s call?\n\nBest,\nNora'},{partId:'html',contentType:'text/html',text:'<div style="font:14px Arial;line-height:1.6;color:#263443;max-width:620px"><p>Hi Mira,</p><p>Please review the final comments in the attached agreement. The revised notice period is highlighted in <strong>section 4</strong>.</p><table style="border-collapse:collapse;width:100%"><tr style="background:#f2f5f7"><th style="padding:10px;text-align:left">Open point</th><th style="padding:10px;text-align:left">Proposed position</th></tr><tr><td style="padding:10px;border-bottom:1px solid #ddd">Notice period</td><td style="padding:10px;border-bottom:1px solid #ddd">60 days</td></tr></table><p>Could you confirm our position before tomorrow’s call?</p><p>Best,<br>Nora</p></div>'}]}));
const raw=Buffer.from('From: Nora <nora@example.test>\r\nMessage-ID: <original@example.test>\r\n\r\nPlease review the attached agreement.');
const parts=[{kind:'raw',bytes:raw,type:'message/rfc822',id:''},{kind:'body',bytes:body,type:'application/json',id:''},{kind:'attachment',bytes:attachment,type:'text/plain',id:'agreement'}].map(part=>({...part,hash:hash(part.bytes)}));
let mode='large';const drafts=new Map();const seen=new Set();
const server=Bun.serve({hostname:'127.0.0.1',port:5483,fetch:async req=>{const url=new URL(req.url),path=url.pathname,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'};if(req.method==='OPTIONS')return new Response(null,{headers});let input={};if(req.method==='POST'&&req.headers.get('content-type')?.includes('application/json'))input=await req.json();let result;
if(path==='/fixture/mode'){mode=url.searchParams.get('value')||'large';return Response.json({mode},{headers});}
if(path.includes('/mail')){
 if(mode==='error'&&path.endsWith('/messages/query'))return Response.json({error:'mail_unavailable',message:'Synthetic connection interrupted'},{status:503,headers});
 if(mode==='loading'&&path.endsWith('/messages/query'))await new Promise(r=>setTimeout(r,1500));
 const eligible=mode==='empty'?[]:mode==='small'?messages.slice(0,3):messages;
 if(path.endsWith('/status')||path.endsWith('/unlock'))result={state:'ready'};
 else if(path.endsWith('/accounts'))result={items:accounts,nextCursor:null};
 else if(path.endsWith('/folders'))result={items:[{id:'INBOX',name:'Inbox',kind:'folder',parentId:null,role:'inbox',mutationPrecondition:'current'},{id:'sent',name:'Sent',kind:'folder',parentId:null,role:'sent',mutationPrecondition:'current'},{id:'work',name:'Aster',kind:'folder',parentId:null,role:null,mutationPrecondition:'current'}],nextCursor:null};
 else if(path.endsWith('/sync'))result={state:'complete',enumerated:eligible.length,downloaded:eligible.length,projected:eligible.length,failed:0,pending:0,error:null};
 else if(path.endsWith('/messages/query')){const account=path.split('/accounts/')[1].split('/')[0],rows=eligible.filter(item=>item.accountId===account&&(!input.threadId||item.threadId===input.threadId)),offset=Number(input.after||0),limit=input.limit||50;result={items:rows.slice(offset,offset+limit),nextCursor:rows.length>offset+limit?String(offset+limit):null};}
 else if(path.endsWith('/messages/read'))result=messages.find(item=>JSON.stringify(item.locator)===JSON.stringify(input.locator));
 else if(path.endsWith('/messages/parts'))result={items:parts.map(part=>({key:part.kind,kind:part.kind,partId:part.id,state:'stored',referenceId:'sha256:'+part.hash,bytes:part.bytes.length,sha256:part.hash,bytesAvailable:true,filename:part.kind==='attachment'?'Agreement appendix.txt':null,contentType:part.type,contentId:null})),nextCursor:null};
 else if(path.endsWith('/messages/content')){const part=parts.find(part=>'sha256:'+part.hash===input.request.referenceId);result={accountId:path.split('/accounts/')[1].split('/')[0],referenceId:input.request.referenceId,offset:0,totalBytes:part.bytes.length,sha256:part.hash,data:part.bytes.toString('base64'),nextOffset:null};}
 else if(path.endsWith('/events/query'))result={stream:'synthetic',nextCursor:1};
 else if(path.endsWith('/actions/query'))result={items:[],nextCursor:null};
 else if(path.endsWith('/search')){const offset=input.offset||0;result={items:eligible.slice(offset,offset+25).map(item=>({accountId:item.accountId,locator:item.locator,subject:item.subject,sender:item.metadata.from,snippet:'Please review the final comments in the agreement. Revised notice period: 60 days.',date:new Date(item.receivedAt).toISOString(),hasAttachment:true})),total:eligible.length,pending:0,incomplete:0,nextOffset:offset+25<eligible.length?offset+25:null};}
 else if(path.endsWith('/search/saved'))result={action:'list',items:[],nextCursor:null};
 else if(path.endsWith('/senders'))result=[{id:'sender',accountId:path.split('/accounts/')[1].split('/')[0],address:'mira@example.test',displayName:'Mira Chen',source:'provider_verified',available:true,signature:'Mira Chen\nCommercial team',defaultNew:true,defaultReply:true,sendMode:'self'}];
 else if(path.endsWith('/drafts/save')){result={id:input.draftId,version:{generation:'00000000-0000-4000-8000-000000000001',revision:(input.expected?.revision||0)+1},updatedAt:Date.now(),deleted:false,subject:input.content.subject,content:input.content};drafts.set(input.draftId,result);}
 else if(path.endsWith('/drafts/query'))result={accountId:'gmail',items:[...drafts.values()],nextCursor:null};
 else if(path.endsWith('/outbox'))result=[];
 else if(path.endsWith('/credentials'))result={state:'connected',scopes:[]};
 else if(path.endsWith('/filing'))result={items:[],nextOffset:null};
 }
else if(path==='/workspaces')result={items:[workspace],activeId:workspace.id};
else if(path.includes('/workspace/')&&path.endsWith('/activate'))result={workspace};
else if(path.endsWith('/global/health')||path==='/health')result={healthy:true,version:'synthetic'};
else if(path.endsWith('/files/raw'))result={ok:true,path:input.path,updatedAt:Date.now()};
else if(path.endsWith('/sessions/ses_review/snapshot'))result={item:{session,messages:[],todos:[],status:{type:'idle'}}};
else if(path.endsWith('/sessions/ses_review'))result={item:session};
else if(path.endsWith('/sessions'))result={items:[session],nextCursor:null};
else if(path.endsWith('/session-groups'))result={items:[]};
else if(path.endsWith('/eigenwelt/entitlements'))result={active:false};
else if(path.endsWith('/provider'))result={all:[],default:{},connected:[]};
else if(path.endsWith('/agent'))result=[{name:'build',description:'Synthetic model fixture',mode:'primary',hidden:false,permission:[]}];
else if(path.endsWith('/session'))result=[session];
else if(path.endsWith('/session/ses_review'))result=session;
else if(/\/(message|todo|permission|question|skill)$/.test(path))result=[];
else if(path.endsWith('/status')||path.endsWith('/config')||path.endsWith('/mcp')||path.endsWith('/auth'))result={};
else if(path.endsWith('/file/binary'))result={ok:true,path:url.searchParams.get('path'),updatedAt:Date.now()};
if(result===undefined){if(!seen.has(path)){seen.add(path);console.log('UNHANDLED',req.method,path);}result={};}
return Response.json(result,{headers});}});
console.log('Synthetic design server',server.port);
