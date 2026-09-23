const {app,BrowserWindow}=require('electron');
app.setPath('userData',process.argv[2]);
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 try{
  await window.loadFile(process.argv[3]);
  const result=await window.webContents.executeJavaScript(`(async()=>{
   const wait=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+document.body.innerText);};
   const click=text=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===text);if(!button)throw Error('Missing '+text);button.click();};
   await wait(()=>document.body.innerText.includes('Bcc: hidden@example.com'));
   if(document.body.innerText.includes('Grant access')||document.body.innerText.includes('Choose workspace')||document.body.innerText.includes('Allow for session'))throw Error('Retired scope/session controls');
   if(!document.body.innerText.includes('Exact reviewed body'))throw Error('Hidden exact review');
   click('Save account permissions');await wait(()=>window.calls.some(call=>call.action==='set'&&call.accountId==='a'));
   click('Delay next reply');click('Allow once');click('Second chat');
   await wait(()=>document.body.innerText.includes('Exact synthetic subject (second)'));
   click('Release old reply');await new Promise(r=>setTimeout(r,50));
   if(document.body.innerText.includes('Exact synthetic subject (first)'))throw Error('Stale reply crossed chats');
   click('Toggle remote chat');await wait(()=>!document.body.innerText.includes('Exact reviewed body'));
   return 'AGENT_UI_PASS';
  })()`);
  console.log(result);app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
});
