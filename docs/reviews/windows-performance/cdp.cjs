async function connect(port=9230) {
 const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const target = targets.find(x=>x.type===(port===9231?'node':'page'));
 const ws = new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let seq=0;const pending=new Map();const listeners=new Map();
 ws.onmessage=e=>{const v=JSON.parse(e.data);if(v.id){const p=pending.get(v.id);pending.delete(v.id);if(v.error)p.reject(v.error);else p.resolve(v.result);}else for(const f of listeners.get(v.method)||[]) f(v.params);};
 return {send(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});},on(method,fn){listeners.set(method,[...(listeners.get(method)||[]),fn]);},close(){ws.close();}};
}
module.exports={connect};
if(require.main===module) (async()=>{const c=await connect(Number(process.argv[2])||9230);try{console.log(JSON.stringify(await c.send('Runtime.evaluate',{expression:process.argv[3]||'({url:location.href,text:document.body.innerText.slice(0,4000)})',returnByValue:true,awaitPromise:true})));}finally{c.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
