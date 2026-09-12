import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {openMailPreview,readMailPreview} from '../src/react-app/domains/session/artifacts/mail-preview-source';
import {EVALS_PANEL_SESSION_ID,usePanelTabStore} from '../src/react-app/domains/session/panel/panel-tab-store';

test('mail image preview rejects decoded dimension bombs and spoofed types before replacing the verified tab',()=>{
 const bytes=new Uint8Array(readFileSync(new URL('../../server/src/mail/testing/html-fixtures/brand.png',import.meta.url)));
 const abort=new AbortController();
 try {
  openMailPreview({name:'brand.png',bytes,type:'image',mime:'image/png'},abort.signal);
  const previous=usePanelTabStore.getState().sessions[EVALS_PANEL_SESSION_ID].activeTabId!;
  expect(readMailPreview(previous)?.bytes).toBe(bytes);
  const bomb=bytes.slice();new DataView(bomb.buffer).setUint32(16,100000);
  for(const input of [{bytes:bomb,mime:'image/png'},{bytes,mime:'image/jpeg'},{bytes:new TextEncoder().encode('<svg onload="alert(1)"/>'),mime:'image/svg+xml'}]) {
   expect(()=>openMailPreview({name:'untrusted.png',type:'image',...input},abort.signal)).toThrow('safe preview');
   expect(usePanelTabStore.getState().sessions[EVALS_PANEL_SESSION_ID].activeTabId).toBe(previous);
  }
 }finally{abort.abort();}
});
