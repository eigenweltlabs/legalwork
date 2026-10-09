const {connect}=require('./cdp.cjs');const fs=require('node:fs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const page=await connect(); const requests=[];const starts=new Map();
 const evaluate=async expression=>{const r=await page.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 try {
  await page.send('Network.enable');
  page.on('Network.requestWillBeSent',e=>{if(new URL(e.request.url).pathname.endsWith('/opencode/provider')){const item={start:e.timestamp,status:null,ms:null};starts.set(e.requestId,item);requests.push(item);}});
  page.on('Network.responseReceived',e=>{const item=starts.get(e.requestId);if(item)item.status=e.response.status;});
  page.on('Network.loadingFinished',e=>{const item=starts.get(e.requestId);if(item)item.ms=Math.round((e.timestamp-item.start)*1000);});
  await evaluate("location.hash='/workspace/ws_live/settings/general';true");
  await sleep(2000);requests.length=0;starts.clear();
  await page.send('Page.reload',{ignoreCache:true});await sleep(10000);
  const beforePicker=requests.length;
  await evaluate("window.dispatchEvent(new CustomEvent('legalwork-open-model-picker'));true");await sleep(5000);
  const result={label:process.argv[2]||'current',beforePicker,afterPicker:requests.length,requests:requests.map(({ms,status})=>({ms,status})),dialogVisible:await evaluate('Boolean(document.querySelector(\'[role="dialog"]\'))')};
  console.log(JSON.stringify(result));fs.writeFileSync(`provider-cache-${result.label}.json`,JSON.stringify(result,null,2));
 }finally{page.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
