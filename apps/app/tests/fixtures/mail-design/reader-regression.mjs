/** Run only against the root-approved synthetic EIG-172 preview. Does not launch Electron. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const control='http://127.0.0.1:5484';
const deadline=AbortSignal.timeout(90000);
async function call(path,input={}) {
 const response=await fetch(control+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.any([deadline,AbortSignal.timeout(10000)])});
 if(!response.ok)throw Error(`Synthetic control ${path}: ${response.status}`);
 return response.json();
}
const run=code=>call('/eval',{code});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(code,attempts=100) {
 for(let attempt=0;attempt<attempts;attempt++){if(await run(code))return;await pause(40);}
 throw Error('Reader condition did not settle: '+code);
}
const evidence=[];
try {
 assert.equal(await run('location.origin'),'http://127.0.0.1:5482');
 await until("document.querySelectorAll('.mail-message-row').length>=4");
 await run("window.readerProbeLoads=0;document.addEventListener('load',event=>{if(event.target instanceof HTMLIFrameElement)window.readerProbeLoads++},true)");
 for(let index=0;index<20;index++) {
  const row=index%3;
  await run(`(()=>{const rows=document.querySelectorAll('.mail-message-row');${index%2?'rows[3].click();':''}rows[${row}].click();})()`);
  await until(`document.querySelectorAll('.mail-message-row')[${row}].getAttribute('aria-pressed')==='true'`);
  await until("document.querySelector('#mail-print-root iframe')?.getBoundingClientRect().height>80");
  const selected=await run("JSON.parse(document.querySelector('[data-mail-reader]').dataset.mailReader)");
  const key=JSON.parse(selected[1]);
  let frames=[];const observations=[];const started=Date.now();
  for(let attempt=0;attempt<100;attempt++){
   frames=await call('/frames');observations.push({elapsedMs:Date.now()-started,selected:await run("document.querySelector('[data-mail-reader]').dataset.mailReader"),frames:frames.map(frame=>({...frame,text:frame.text?.slice(0,320)}))});
   if(frames.some(frame=>frame.text?.includes(key[1])&&frame.bodyHeight>0&&frame.viewport>=frame.scrollHeight-1))break;
   await pause(40);
  }
  evidence.push({open:index+1,selected:key[1],observations,loads:await run('window.readerProbeLoads')});
  assert.ok(frames.some(frame=>frame.text?.includes(key[1])&&frame.bodyHeight>0&&frame.viewport>=frame.scrollHeight-1),`Selected body absent or clipped: ${key[1]}`);
  if(index%4===0){
   await run("document.querySelector('#mail-print-root .mail-body-options button').click()");
   await until("!document.querySelector('#mail-print-root iframe')&&!!document.querySelector('#mail-print-root .mail-plain-body')");
   await run("document.querySelector('#mail-print-root .mail-body-options button').click()");
   await until("document.querySelector('#mail-print-root iframe')?.getBoundingClientRect().height>80");
  }
  if(index===0)await call('/capture',{name:'eig-139-first-visible-body',width:1440,height:960});
 }
 const current=await run("JSON.parse(document.querySelector('[data-mail-reader]').dataset.mailReader)");
 const currentId=JSON.parse(current[1])[1];
 const configure=async input=>{const response=await fetch('http://127.0.0.1:5483/fixture/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:deadline});assert.equal(response.ok,true);};
 await configure({messageId:currentId,contentState:'downloading'});
 await until("document.querySelector('#mail-print-root .mail-content-warning')!==null",300);
 await configure({messageId:currentId,contentState:'complete'});
 await until("!document.querySelector('#mail-print-root .mail-content-warning')&&document.querySelector('#mail-print-root iframe')?.getBoundingClientRect().height>80",300);
 await until("document.querySelector('[aria-label=\"Mark unread\"]:not(:disabled)')!==null");
 const state=()=>fetch('http://127.0.0.1:5483/fixture/state',{signal:deadline}).then(response=>response.json());
 const beforeUnread=await state();
 await run("document.querySelector('[aria-label=\"Mark unread\"]').click()");
 let unread=await state();
 for(let attempt=0;unread.mutations.length===beforeUnread.mutations.length&&attempt<100;attempt++){await pause(40);unread=await state();}
 assert.equal(unread.mutations.length,beforeUnread.mutations.length+1,'Explicit Mark unread should queue exactly one action');
 await run("window.readerProbeFrames=[...document.querySelectorAll('iframe')];window.readerProbeDocs=readerProbeFrames.map(frame=>frame.srcdoc);window.readerProbeIdleLoads=readerProbeLoads;document.querySelector('.mail-reader-pane').scrollTop=50;window.readerProbeScroll=document.querySelector('.mail-reader-pane').scrollTop");
 await pause(11500);
 assert.equal(await run("readerProbeFrames.every((frame,index)=>frame===document.querySelectorAll('iframe')[index]&&frame.srcdoc===readerProbeDocs[index])"),true);
 assert.equal(await run('readerProbeLoads===readerProbeIdleLoads'),true);
 assert.equal(await run("document.querySelector('.mail-reader-pane').scrollTop===readerProbeScroll"),true);
 const afterIdle=await state();assert.equal(afterIdle.mutations.length,unread.mutations.length,'Idle polling must not requeue read after explicit Mark unread');
 await call('/capture',{name:'eig-139-after-idle',width:1440,height:960});
 await configure({messageId:currentId,failContentOnce:true});
 await run("document.querySelectorAll('.mail-message-row')[2].click()");
 await until("document.querySelectorAll('.mail-message-row')[2].getAttribute('aria-pressed')==='true'");
 await run("document.querySelectorAll('.mail-message-row')[1].click()");
 await until("document.querySelector('#mail-print-root .mail-notice')!==null");
 await until("document.querySelector('#mail-print-root iframe')?.getBoundingClientRect().height>80&&!document.querySelector('#mail-print-root .mail-notice')",300);
 const recovered=await call('/frames');assert.ok(recovered.some(frame=>frame.text?.includes(currentId)),'Initial content failure must recover without changing raw/state');
 const longResponse=await fetch('http://127.0.0.1:5483/fixture/conversation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:55}),signal:deadline});
 assert.equal(longResponse.ok,true);
 await run("document.querySelector('[aria-label=\"Refresh mail\"]').click()");
 await until("[...document.querySelectorAll('.mail-message-row')].some(row=>row.textContent.includes('Synthetic extended conversation'))");
 await run("[...document.querySelectorAll('.mail-message-row')].find(row=>row.textContent.includes('Synthetic extended conversation')).click()");
 await until("document.querySelectorAll('.mail-conversation-message').length===25");
 await run("[...document.querySelectorAll('.mail-conversation button')].find(button=>button.textContent==='Load earlier messages').click()");
 await until("document.querySelectorAll('.mail-conversation-message').length===50");
 await pause(5500);
 await run("[...document.querySelectorAll('.mail-conversation button')].find(button=>button.textContent==='Load earlier messages').click()");
 await until("document.querySelectorAll('.mail-conversation-message').length===55");
 await pause(5500);
 assert.equal(await run("[...document.querySelectorAll('.mail-conversation button')].some(button=>button.textContent==='Load earlier messages')"),false);
 assert.equal(await run("document.querySelectorAll('.mail-conversation iframe').length"),1);
 await fetch('http://127.0.0.1:5483/fixture/reset',{method:'POST',signal:deadline});
 await run("document.querySelector('[aria-label=\"Refresh mail\"]').click()");
 await writeFile('/tmp/eig-139-reader-regression.json',JSON.stringify({result:'pass',opens:20,plainBoundaries:5,idleMs:11500,conversationPages:[25,50,55],evidence},null,2));
 console.log('EIG-139 synthetic reader: 20 first/rapid opens, 5 plain/HTML boundaries and unchanged idle frames passed.');
} catch(error) {
 await call('/capture',{name:'eig-139-failure-preserved',width:1440,height:960}).catch(()=>{});
 await writeFile('/tmp/eig-139-reader-regression.json',JSON.stringify({result:'failed',error:String(error),evidence,frames:await call('/frames').catch(()=>null)},null,2));
 throw error;
}
