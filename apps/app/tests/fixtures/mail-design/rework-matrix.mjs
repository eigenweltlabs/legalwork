import assert from 'node:assert/strict';
const call=async(path,value={})=>{const result=await fetch('http://127.0.0.1:5484/'+path,{method:'POST',body:JSON.stringify(value)});if(!result.ok)throw Error(await result.text());return result.json();};
const run=code=>call('eval',{code});
const until=async code=>{for(let i=0;i<160;i++){if(await run(code))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error(code);};
const capture=(name,width=1440,height=920)=>call('capture',{name:'rework-'+name,width,height});
await fetch('http://127.0.0.1:5483/fixture/reset',{method:'POST'});
await run('location.hash="/mail";location.reload()');
await until('document.querySelectorAll(".mail-message-row").length===25');
await call('visibility',{visible:true,duration:90000});
try{
 await run('document.querySelector(".mail-message-row").click()');
 await until('document.querySelectorAll(".mail-conversation-toggle").length===3&&!!document.querySelector("#mail-print-root iframe")');
 await capture('conversation');
 await capture('reader-1100',1100,850);
 await capture('reader-600',600,850);
 await run('document.querySelector(".mail-reader-pane>.mail-back").click()');
 await capture('list-600',600,850);
 await capture('mailbox-wide',1800,1000);
 await run('(()=>{const input=document.querySelector("[aria-label=\\"Search mail\\"]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"agreement");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
 await until('document.querySelectorAll(".mail-search-subject").length===25');
 await capture('search');
 // The public command label remains stable across toolbar copy changes.
 await run('document.querySelector(".mail-compose-launch").click()');
 await until('!!document.querySelector(".mail-composer")');
 await capture('compose');
 assert.equal(await run('document.querySelector(".mail-action-activity")===null'),true);
 console.log('REWORK_MAIL_MATRIX_PASS');
}finally{await call('visibility',{visible:false});}
