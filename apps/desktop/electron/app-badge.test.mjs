import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppBadge, createMailBadgeController, badgeBitmap } from './app-badge.mjs';

test('Dock clears zero and composes independent component counts', () => {
 const values=[]; const badge=createAppBadge({dock:{setBadge:v=>values.push(v)}},null,()=>[],'darwin');
 badge.set('tasks',2);badge.set('mail',4);badge.set('mail',0);badge.set('tasks',0);
 assert.deepEqual(values,['2','6','2','']);
});
test('Windows overlay uses native BGRA image and clears/reapplies on window creation', () => {
 const values=[];const windows=[{isDestroyed:()=>false,setOverlayIcon:(...v)=>values.push(v)}];
 const badge=createAppBadge({}, {createFromBitmap:(buffer,options)=>({buffer,options})},()=>windows,'win32');
 badge.set('mail',123);assert.equal(values[0][0].buffer.length,4096);assert.equal(values[0][1],'123 unread items');badge.render();badge.set('mail',0);assert.deepEqual(values.at(-1),[null,'']);
 assert.notDeepEqual(badgeBitmap(1),badgeBitmap(2));assert.deepEqual(badgeBitmap(100),badgeBitmap(999));
});
test('background refresh follows local read/sync/disconnect and respects preference/in-flight stop', async () => {
 let count=7,state='ready',resolve;const values=[];
 const service={status:()=>({state}),unreadInboxCount:async()=>count};
 const controller=createMailBadgeController({service,badge:{set:(_,v)=>values.push(v)},intervalMs:999999});
 await new Promise(r=>setImmediate(r));assert.equal(values.at(-1),7);
 count=3;await controller.refresh();assert.equal(values.at(-1),3);
 controller.setEnabled(false);assert.equal(values.at(-1),0);await new Promise(r=>setImmediate(r));
 controller.setEnabled(true);await new Promise(r=>setImmediate(r));assert.equal(values.at(-1),3);
 count=0;await controller.refresh();assert.equal(values.at(-1),0);
 state='locked';await controller.refresh();assert.equal(values.at(-1),0);state='ready';
 service.unreadInboxCount=()=>new Promise(r=>{resolve=r});const pending=controller.refresh();controller.stop();resolve(8);await pending;assert.equal(values.at(-1),0);
});

test('Settings preference persists independently and restores on controller replacement', async () => {
 const {EventEmitter}=await import('node:events');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {configureMailBadge,getMailBadgeEnabled,setMailBadgeEnabled}=await import('./app-badge.mjs');
 const directory=await mkdtemp(join(tmpdir(),'badge-preference-'));const app=new EventEmitter();app.getPath=()=>directory;app.dock={setBadge:()=>{}};
 const makeService=()=>({status:()=>({state:'ready'}),unreadInboxCount:async()=>4,stop:async()=>{}});let service=makeService();
 try {
  await configureMailBadge({app,nativeImage:null,BrowserWindow:{getAllWindows:()=>[]},service});assert.equal(getMailBadgeEnabled(),true);
  await setMailBadgeEnabled(false);assert.equal(getMailBadgeEnabled(),false);await service.stop();
  service=makeService();await configureMailBadge({app,nativeImage:null,BrowserWindow:{getAllWindows:()=>[]},service});assert.equal(getMailBadgeEnabled(),false);
  await setMailBadgeEnabled(true);assert.equal(getMailBadgeEnabled(),true);await assert.rejects(setMailBadgeEnabled('false'));
 } finally {await service.stop();await rm(directory,{recursive:true,force:true});}
});

test('Tasks and Mail share the OS badge through mail restart and independent preferences', async () => {
 const {EventEmitter}=await import('node:events');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {getAppBadge,configureMailBadge,setMailBadgeEnabled}=await import('./app-badge.mjs');
 const directory=await mkdtemp(join(tmpdir(),'shared-badge-'));const values=[];
 const record=value=>values.push(parseInt(value,10)||0);const app=new EventEmitter();
 app.getPath=()=>directory;app.dock={setBadge:record};app.setBadgeCount=record;
 const options={app,nativeImage:{createFromBitmap:()=>({})},BrowserWindow:{getAllWindows:()=>[{isDestroyed:()=>false,setOverlayIcon:(_image,label)=>record(label)}]}};
 const makeService=count=>({status:()=>({state:'ready'}),unreadInboxCount:async()=>count,stop:async()=>{}});
 const first=makeService(4),second=makeService(5);const settle=()=>new Promise(resolve=>setImmediate(resolve));
 try {
  const badge=getAppBadge(options);badge.set('tasks',2);
  await configureMailBadge({...options,service:first});await settle();assert.equal(values.at(-1),6);
  await configureMailBadge({...options,service:second});await settle();assert.equal(values.at(-1),7);
  await first.stop();assert.equal(values.at(-1),7);
  assert.equal(app.listenerCount('browser-window-created'),1);
  app.emit('browser-window-created');assert.equal(values.at(-1),7);
  await setMailBadgeEnabled(false);await settle();assert.equal(values.at(-1),2);
  await setMailBadgeEnabled(true);await settle();assert.equal(values.at(-1),7);
  badge.set('tasks',0);assert.equal(values.at(-1),5);
  await second.stop();assert.equal(values.at(-1),0);
 } finally {await first.stop();await second.stop();await rm(directory,{recursive:true,force:true});}
});
