import assert from 'node:assert/strict';
const call=async(path,input)=>{const response=await fetch('http://127.0.0.1:5484/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});if(!response.ok)throw Error(await response.text());return response.json();};
const run=code=>call('eval',{code});const pause=()=>new Promise(r=>setTimeout(r,100));
await run(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Contract review')?.click()`);await pause();
for(let i=0;i<50;i++){if(await run(`!!document.querySelector('[contenteditable=true]')`))break;await pause();}
await call('input-mode',{active:true});await pause();
try {
await run(`window.fixtureEditor=document.querySelector('[contenteditable=true]').__lexicalEditor;window.fixtureSaved=fixtureEditor.getEditorState().toJSON()`);
const serialized=await run('JSON.stringify(fixtureSaved)');assert.ok(serialized.includes('[Source email](/mail?source='));
// Copy into an in-memory DataTransfer; never touch the user's OS clipboard.
await run(`(()=>{const root=document.querySelector('[contenteditable=true]');root.focus();getSelection().selectAllChildren(root);document.dispatchEvent(new Event('selectionchange'));})()`);await pause();
const copied=await run(`(()=>{const data=new DataTransfer();document.querySelector('[contenteditable=true]').dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));return data.getData('text/plain');})()`);assert.ok(copied.includes('[Source email](/mail?source='));assert.ok(copied.includes('attachment://workspace'));
const select=position=>run(`(()=>{const root=document.querySelector('[contenteditable=true]');root.focus();const paragraph=root.lastElementChild;getSelection().collapse(paragraph,${position==='selectEnd'?'paragraph.childNodes.length':'0'});document.dispatchEvent(new Event('selectionchange'));})()`);
await select('selectStart');await pause();await call('key',{key:'ArrowRight'});await pause();
assert.equal(await run(`document.querySelectorAll('[contenteditable=true] [aria-label="Return to source email"]').length`),1);
await call('key',{key:'ArrowLeft'});await pause();
assert.equal(await run(`document.querySelectorAll('[contenteditable=true] [aria-label="Return to source email"]').length`),1);
await select('selectEnd');await pause();await call('key',{key:'Backspace'});await pause();
assert.equal(await run(`document.querySelectorAll('[contenteditable=true] [aria-label="Return to source email"]').length`),0);
assert.ok(await run(`document.querySelector('[contenteditable=true]').innerText.includes('Agreement appendix.txt')`));
await run('fixtureEditor.setEditorState(fixtureEditor.parseEditorState(JSON.stringify(fixtureSaved)))');await pause();
assert.equal(await run(`document.querySelectorAll('[contenteditable=true] [aria-label="Return to source email"]').length`),1);
await select('selectStart');await pause();await call('key',{key:'Delete'});await pause();
assert.equal(await run(`document.querySelectorAll('[contenteditable=true] [aria-label="Return to source email"]').length`),0);
await run('fixtureEditor.setEditorState(fixtureEditor.parseEditorState(JSON.stringify(fixtureSaved)))');await pause();
await run(`document.querySelector('[contenteditable=true] [aria-label="Return to source email"]').focus()`);await call('key',{key:'Enter'});await pause();
assert.equal(await run('location.hash'), '#/mail');
await run(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent==='Contract review').click()`);await pause();
assert.equal(await run(`JSON.stringify(document.querySelector('[contenteditable=true]').__lexicalEditor.getEditorState().toJSON()).includes('[Source email](/mail?source=')`),true);
console.log('REAL_LEXICAL_ROUNDTRIP_CLIPBOARD_ATOMIC_KEYS_PASS');

}finally{await call('input-mode',{active:false});}
