// Awaited ESM entry loading preserves privileged-scheme registration before ready.
import {app,BrowserWindow,session} from 'electron';
import {writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const dist=values=>{const s=[...values].sort((a,b)=>a-b);return{count:s.length,p50:s[Math.floor((s.length-1)*.5)]??0,p95:s[Math.floor((s.length-1)*.95)]??0,max:s.at(-1)??0};};
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));app.setPath('userData',config.profile);
assert.equal(app.isReady(),false,'ESM entry must import actual main before ready');
app.once('ready',()=>session.defaultSession.webRequest.onBeforeRequest((details,done)=>{const url=new URL(details.url);done({cancel:['http:','https:'].includes(url.protocol)&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)});}));
const originalFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(Error('Synthetic desktop benchmark forbids external network'));return originalFetch(input,init);};
try{await import(pathToFileURL(join(config.repository,'apps/desktop/electron/main.mjs')).href);}catch(error){console.error(error);app.exit(1);}
// Leave the entry module free to finish: awaiting ready at top level would delay ready itself.
(async()=>{
 // performance.now() includes this measured process's module/startup work; key preparation is separate.
 const started=0;await app.whenReady();
 let win;const windowDeadline=Date.now()+60000;
 while(Date.now()<windowDeadline){win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html'));if(win&&!win.webContents.isLoadingMainFrame())break;await delay(50);}
 assert(win,'actual main application window required');win.setSize(1440,1000);win.show();win.focus();
 let stage='startup';const report={kind:'built-app-synthetic-mail-renderer',count:config.count,corpusSha256:config.corpusSha256,sourceSha256:config.sourceSha256,coldDefinition:'new desktop process and service; OS cache retained',paintTimingDefinition:'Trusted input or insertText to observed matching DOM and two renderer frames; main-process observations include up to25ms polling delay. Scroll also records event-handler-to-frame latency separately.',scope:'Built LegalWork main.mjs, production preload, complete React shell, embedded HTTP server, Electron mail worker and actual OS safeStorage. Unpackaged build; no installer or provider transport.',commit:process.env.GITHUB_SHA??null,stages:[],memory:{electronFamilySampledPeakWorkingSetBytes:0,sampleIntervalMs:1000},errors:[]};
 const memoryTimer=setInterval(()=>{report.memory.electronFamilySampledPeakWorkingSetBytes=Math.max(report.memory.electronFamilySampledPeakWorkingSetBytes,app.getAppMetrics().reduce((sum,p)=>sum+p.memory.workingSetSize*1024,0));},1000);
 const run=async(source)=>{let timer;try{return await Promise.race([win.webContents.executeJavaScript(source,true),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(stage+' renderer execution deadline')),10000);})]);}finally{clearTimeout(timer);}};
 const until=async(source,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await run(source))return;await delay(25);}throw Error(stage+' UI state deadline '+source);};
 try{
  await run("window.location.hash='/mail'");
  await until("!!window.__LEGALWORK_ELECTRON__",10000);
  const infoDeadline=Date.now()+60000;let info;
  while(Date.now()<infoDeadline){info=await run("window.__LEGALWORK_ELECTRON__.invokeDesktop('legalworkServerInfo')");if(info?.running&&info.hostToken)break;await delay(100);}
  assert(info?.running&&info.hostToken,'actual embedded server required');
  const mail=async(path,body)=>{const response=await fetch(info.baseUrl+'/mail/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-LegalWork-Host-Token':info.hostToken},body:JSON.stringify(body)});assert(response.ok,`mail ${path} status ${response.status}`);return response.json();};
  await until("document.querySelectorAll('.mail-message-row').length>0",60000);
  report.startupToMailRowsMs=performance.now()-started;
  await run(`window.bench={frames:[],longTasks:[],wheels:[]};addEventListener('wheel',event=>{const begin=performance.now(),trusted=event.isTrusted;requestAnimationFrame(()=>requestAnimationFrame(()=>window.bench.wheels.push({ms:performance.now()-begin,trusted})))},true);let last=performance.now();function frame(now){window.bench.frames.push(now-last);last=now;requestAnimationFrame(frame)}requestAnimationFrame(frame);new PerformanceObserver(list=>{window.bench.longTasks.push(...list.getEntries().map(e=>e.duration))}).observe({type:'longtask',buffered:false});`);
  const click=async(selector,index=0)=>{const rect=await run(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)throw Error('missing target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...rect});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...rect});};
  const cycle=async name=>{
   stage=name;await run('window.bench.frames=[];window.bench.longTasks=[]');const actions=[];
   for(let i=0;i<10;i++){
    const row=i%await run("document.querySelectorAll('.mail-message-row').length"),identifier=await run(`document.querySelectorAll('.mail-message-row')[${row}].textContent.match(new RegExp('AZ-[0-9]{6}/34[.]5'))[0]`);
    const messageNumber=Number(identifier.slice(3,9)),identity=JSON.stringify([['benchmark-a','benchmark-b','benchmark-c'][messageNumber%3],{provider:'gmail',messageId:'message-'+String(messageNumber).padStart(6,'0')}]);
    const before=performance.now();await click('.mail-message-row',row);await until(`(()=>{const article=document.querySelector('#mail-print-root');return article?.dataset.mailIdentity===${JSON.stringify(identity)} && [...article.querySelectorAll('.mail-plain-body')].some(body=>body.getClientRects().length>0 && getComputedStyle(body).visibility==='visible' && body.textContent.includes(${JSON.stringify(identifier)}));})()`);
    await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');actions.push({kind:'openMessageToPaint',ms:performance.now()-before});
    const wheels=await run('window.bench.wheels.length'),prior=await run("document.querySelector('.mail-message-scroll').scrollTop");
    const rect=await run("(()=>{const r=document.querySelector('.mail-message-scroll').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    const dispatched=performance.now();win.webContents.sendInputEvent({type:'mouseWheel',deltaY:i%2?-200:200,deltaX:0,...rect});await until(`window.bench.wheels.length>${wheels}`);
    const wheel=await run('window.bench.wheels.at(-1)');assert.equal(wheel.trusted,true);
    actions.push({kind:'trustedScrollInputToObservedFrame',ms:performance.now()-dispatched,eventHandlerToSecondFrameMs:wheel.ms,changed:await run("document.querySelector('.mail-message-scroll').scrollTop")!==prior});
   }
   assert.ok(actions.some(action=>action.changed),'wheel input must move actual message list');
   for(const [query,expectedTotal,expectedNumber] of [['diligence',config.count-Math.ceil(config.count/1000),null],['AZ-000001/34.5',1,1],['AttachmentEvidence000011',1,11]]){
    // Independent production-query validation is outside the UI timing interval.
    const pendingBefore=await mail('search',{literal:query,limit:20});
    if(name==='steady'){assert.equal(pendingBefore.pending,0);assert.equal(pendingBefore.total,expectedTotal);}
    await click('input[aria-label="Search mail"]');win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']});
    const before=performance.now();await win.webContents.insertText(query);
    const snapshotSource=`(()=>({query:document.querySelector('input[aria-label="Search mail"]')?.value,status:document.querySelector('.mail-results-toolbar [role=status]')?.textContent,keys:[...document.querySelectorAll('[aria-label="Search results"] .mail-search-subject')].map(e=>e.dataset.mailRowKey)}))()`;
    const expectedKeys=pendingBefore.items.map(hit=>hit.accountId+'|'+JSON.stringify(hit.locator));
    await until(`(()=>{const state=${snapshotSource};return state.query===${JSON.stringify(query)} && /^[0-9]+ matches?$/.test(state.status??'') ${name==='steady'?`&& parseInt(state.status,10)===${expectedTotal} && JSON.stringify(state.keys)===${JSON.stringify(JSON.stringify(expectedKeys))}`:''};})()`);
    await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const measuredMs=performance.now()-before,state=await run(snapshotSource),pendingAfter=await mail('search',{literal:query,limit:20}),total=parseInt(state.status,10);
    assert(total>=pendingBefore.total&&total<=pendingAfter.total,'painted result count must match production query progress');
    assert.equal(state.keys.length,Math.min(total,20),'painted result rows must match count');
    for(const key of state.keys){const separator=key.indexOf('|'),accountId=key.slice(0,separator),locator=JSON.parse(key.slice(separator+1)),number=Number(locator.messageId?.slice(8));assert.equal(locator.provider,'gmail');assert(Number.isSafeInteger(number)&&number>=0&&number<config.count);assert.equal(accountId,['benchmark-a','benchmark-b','benchmark-c'][number%3]);if(expectedNumber!==null)assert.equal(number,expectedNumber);else assert.notEqual(number%1000,3,'malformed originals cannot match diligence');}
    actions.push({kind:'searchInputToResultsPaint',query,ms:measuredMs,status:state.status,identities:state.keys,expectedTotal,pendingBefore:pendingBefore.pending,pendingAfter:pendingAfter.pending,incomplete:pendingAfter.incomplete});
    await click('button[aria-label="Clear search"]');await until("document.querySelectorAll('.mail-message-row').length>0 && !document.querySelector('.mail-results-toolbar')");
   }
   const telemetry=await run('window.bench');report.stages.push({name,actions,frameIntervalMs:dist(telemetry.frames),longTaskMs:dist(telemetry.longTasks),visibleRows:await run("document.querySelectorAll('.mail-message-row').length")});

  };
  await cycle('steady');
  report.rebuildStart=[];for(const accountId of ['benchmark-a','benchmark-b','benchmark-c'])report.rebuildStart.push(await mail('search/rebuild',{accountId,reset:true,limit:1}));
  const overlap=await mail('search',{literal:'diligence',limit:1});report.backgroundCycleStart={pending:overlap.pending,total:overlap.total,incomplete:overlap.incomplete};
  if(config.count===100000)assert(overlap.pending>0,'100k background cycle must overlap actual reindex work');
  await cycle('background-reindex');
  const deadline=Date.now()+15*60000;let progress;
  do{progress=await mail('search',{literal:'diligence',limit:1});if(!progress.pending)break;await delay(1000);}while(Date.now()<deadline);
  assert.equal(progress.pending,0,'reindex must finish without hidden dirty work');assert.equal(progress.total,config.count-Math.ceil(config.count/1000));report.rebuildComplete={pending:progress.pending,total:progress.total,incomplete:progress.incomplete};
  report.elapsedMs=performance.now()-started;await writeFile(config.output,JSON.stringify(report,null,2)+'\n');console.log('MAIL_RENDERER_BENCHMARK_PASS');app.quit();
 }catch(error){report.errors.push({stage,message:error.message});report.domDiagnostic=await run('document.body.innerText.slice(0,2000)').catch(()=>null);await writeFile(config.output,JSON.stringify(report,null,2)+'\n');throw error;}finally{clearInterval(memoryTimer);}
})().catch(error=>{console.error(error);app.exit(1);});
