import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const source = new URL("./mail-key-store.mjs", import.meta.url).href;

/** Isolated child hooks real filesystem operations at the exact race window.
 * The in-memory wrapping map is only a mock OS vault, never production crypto. */
function probe(body) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import {randomBytes} from 'node:crypto';
    import {tmpdir} from 'node:os';
    import {join,dirname} from 'node:path';
    const root=await fs.promises.mkdtemp(join(tmpdir(),'legalwork-key-races-'));
    const directory=join(root,'mail');
    await fs.promises.mkdir(directory,{mode:0o700});
    const wrapped=new Map();
    const safeStorage={
      isEncryptionAvailable:()=>true,
      getSelectedStorageBackend:()=>'gnome_libsecret',
      encryptString(text){const token=randomBytes(64);wrapped.set(token.toString('base64'),text);return token;},
      decryptString(bytes){const value=wrapped.get(bytes.toString('base64'));if(!value)throw new Error('mock locked');return value;},
    };
    const source=${JSON.stringify(source)};
    try { ${body} } finally { await fs.promises.rm(root,{recursive:true,force:true}); }
  `], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("reader fsyncs key publication and parent before returning during creator pause", { skip: process.platform === "win32" }, () => probe(`
  let publishedResolve, release;
  const published=new Promise(resolve=>publishedResolve=resolve);
  const resume=new Promise(resolve=>release=resolve);
  const originalLink=fs.promises.link;
  const originalOpen=fs.promises.open;
  const synced=new Set();
  fs.promises.link=async(...args)=>{await originalLink(...args);publishedResolve();await resume;};
  fs.promises.open=async(...args)=>{
    const handle=await originalOpen(...args);
    const sync=handle.sync.bind(handle);
    handle.sync=async()=>{await sync();synced.add(String(args[0]));};
    return handle;
  };
  syncBuiltinESMExports();
  const {createMailKeyStore}=await import(source);
  const creating=createMailKeyStore({directory,safeStorage}).load({allowCreate:true});
  try {
    await published;
    assert.equal(synced.has(directory),false);
    const key=await createMailKeyStore({directory,safeStorage}).load();
    // The creator is still blocked before its own directory sync.
    assert.ok(synced.has(directory),'reader returned before syncing the published key');
    assert.ok(synced.has(dirname(directory)),'reader returned before syncing the new directory');
    release();
    const winner=await creating;
    assert.deepEqual(key,winner);
    key.fill(0);winner.fill(0);
  } finally { release();await creating.catch(()=>{}); }
`));

test("initializer rereads the winner when another activation creates the database after ENOENT", () => probe(`
  let missingResolve, release;
  const missing=new Promise(resolve=>missingResolve=resolve);
  const resume=new Promise(resolve=>release=resolve);
  const originalOpen=fs.promises.open;
  let intercept=true;
  fs.promises.open=async(...args)=>{
    try{return await originalOpen(...args);}
    catch(error){
      if(intercept&&String(args[0]).endsWith('mail-key-v1.json')&&error.code==='ENOENT'){
        intercept=false;missingResolve();await resume;
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
  const {createMailKeyStore}=await import(source);
  const delayed=createMailKeyStore({directory,safeStorage}).load({allowCreate:true});
  try {
    await missing;
    const winner=await createMailKeyStore({directory,safeStorage}).load({allowCreate:true});
    await fs.promises.writeFile(join(directory,'mail.sqlite'),'synthetic existing store',{mode:0o600});
    release();
    const key=await delayed;
    assert.deepEqual(key,winner);
    key.fill(0);winner.fill(0);
  } finally { release();await delayed.catch(()=>{}); }
`));
