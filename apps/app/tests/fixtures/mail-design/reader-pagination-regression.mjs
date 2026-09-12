/** Targeted continuation in the existing root-approved synthetic preview; never launches Electron. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const signal=AbortSignal.timeout(45000),observations=[];
async function control(path,input={}){const response=await fetch('http://127.0.0.1:5484'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal});assert.equal(response.ok,true);return response.json();}
const run=code=>control('/eval',{code});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(path,input={}){const response=await fetch('http://127.0.0.1:5483/fixture/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal});assert.equal(response.ok,true);return response.json();}
async function until(code){for(let index=0;index<100;index++){if(await run(code))return;await pause(40);}throw Error('Pagination did not settle: '+code);}
const sample=async phase=>observations.push({phase,time:Date.now(),...await run("({cards:document.querySelectorAll('.mail-conversation-message').length,earlier:[...document.querySelectorAll('.mail-conversation button')].some(button=>button.textContent==='Load earlier messages'),frames:document.querySelectorAll('.mail-conversation iframe').length})")});
try{
 assert.equal(await run('location.origin'),'http://127.0.0.1:5482');
 await control('/visibility',{visible:true,duration:30000});
 await api('reset');await api('conversation',{count:55});
 await run("location.hash='/mail';location.reload()").catch(()=>{});
 await until("[...document.querySelectorAll('.mail-message-row')].some(row=>row.textContent.includes('Synthetic extended conversation'))");
 const opened=Date.now();
 await run("[...document.querySelectorAll('.mail-message-row')].find(row=>row.textContent.includes('Synthetic extended conversation')).click()");
 await until("document.querySelectorAll('.mail-conversation-message').length===25");await sample('initial-25');
 assert.ok(observations[0].time-opened<4000,'Initial StrictMode load must not defer to the five-second poll');
 assert.equal(observations[0].earlier,true);
 await run("[...document.querySelectorAll('.mail-conversation button')].find(button=>button.textContent==='Load earlier messages').click()");
 await until("document.querySelectorAll('.mail-conversation-message').length===50");await sample('loaded-50');
 await pause(5500);await sample('poll-after-50');
 await run("[...document.querySelectorAll('.mail-conversation button')].find(button=>button.textContent==='Load earlier messages').click()");
 await until("document.querySelectorAll('.mail-conversation-message').length===55");await sample('loaded-55');
 await pause(5500);await sample('poll-after-55');
 assert.equal(observations.at(-1).earlier,false);assert.equal(observations.at(-1).frames,1);
 await control('/capture',{name:'eig-139-55-message-conversation',width:1440,height:960});
 await writeFile('/tmp/eig-139-pagination-regression.json',JSON.stringify({result:'pass',initialLoadMs:observations[0].time-opened,observations},null,2));
 console.log(JSON.stringify({result:'pass',initialLoadMs:observations[0].time-opened,cards:observations.map(value=>value.cards)}));
 await api('reset');await run("document.querySelector('[aria-label=\"Refresh mail\"]').click()");
}catch(error){await control('/capture',{name:'eig-139-pagination-failure'}).catch(()=>{});await writeFile('/tmp/eig-139-pagination-regression.json',JSON.stringify({result:'failed',error:String(error),observations},null,2));throw error;}
finally{await control('/visibility',{visible:false}).catch(()=>{});}
