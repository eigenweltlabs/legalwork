import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {dispatchMailReply} from './mail-menu-shortcuts.mjs';

test('native reply timeout does not execute a late command or request reload',async()=>{
 let code,commands=0;const contents={getURL:()=> 'https://fixture.test/mail',isDestroyed:()=>false,executeJavaScript:value=>{code=value;return new Promise(()=>{});}};
 assert.equal(await dispatchMailReply(contents,false),'expired');
 const result=vm.runInNewContext(code,{Date:{now:()=>Date.now()+1000},location:{href:contents.getURL()},document:{hasFocus:()=>true,get activeElement(){commands++;return null;}}});
 assert.equal(result,'expired');assert.equal(commands,0);
});
test('native reply drops route/focus changes and never invents fallback after errors',async()=>{
 let url='https://fixture.test/mail',resolve;const contents={getURL:()=>url,isDestroyed:()=>false,executeJavaScript:()=>new Promise(done=>{resolve=done;})};
 const pending=dispatchMailReply(contents,false);url='https://fixture.test/settings';resolve('unused');assert.equal(await pending,'expired');
 const focus=dispatchMailReply(contents,true,()=>false);resolve('unused');assert.equal(await focus,'expired');
 assert.equal(await dispatchMailReply({...contents,executeJavaScript:()=>Promise.reject(Error('gone'))},false),'expired');
});

test('native queued dispatch checks renderer focus before opening and coalesces accelerators',async()=>{
 let code,resolve,executions=0;const contents={getURL:()=> 'https://fixture.test/mail',isDestroyed:()=>false,executeJavaScript:value=>{executions++;code=value;return new Promise(done=>{resolve=done;});}};
 const first=dispatchMailReply(contents,false);assert.equal(await dispatchMailReply(contents,false),'handled');assert.equal(executions,1);
 const result=vm.runInNewContext(code,{Date,location:{href:contents.getURL()},document:{hasFocus:()=>false,get activeElement(){throw Error('must not dispatch');}}});assert.equal(result,'expired');resolve(result);assert.equal(await first,'expired');
});
