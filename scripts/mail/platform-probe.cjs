// Actual Electron main process: no mock OS vault and no provider traffic.
const { app, safeStorage } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const [build, profile, expectedArch] = process.argv.slice(2);
app.setName('Legalwork Mail Platform Qualification'); app.setPath('userData', profile);
app.whenReady().then(async () => {
  app.dock?.hide();
  const load = path => import(pathToFileURL(join(build, path)).href);
  let key, opened;
  try {
    assert.equal(process.arch, expectedArch);
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    const marker = 'synthetic_mail_platform_private_marker';
    const wrapped = safeStorage.encryptString(marker); assert.equal(safeStorage.decryptString(wrapped), marker);
    const { enforceMailWindowsAcl } = await load('mail/storage/windows-acl.js');
    const { openEncryptedMailDatabase } = await load('mail/storage/database.js');
    const { migrateMailSchema } = await load('mail/storage/schema.js');
    const { MailRepository } = await load('mail/storage/repository.js');
    const { MailContentStore } = await load('mail/storage/content-store.js');
    const { MailSearchStore } = await load('mail/storage/search.js');
    const { createMailStoreMaintenance } = await load('mail-store-maintenance.mjs');
    const directory = join(profile, 'mail');
    const manager = createMailStoreMaintenance({directory,safeStorage,windowsAcl:enforceMailWindowsAcl,executable:{kind:'electron',path:process.execPath},entryPoint:join(build,'mail/runtime/maintenance-worker.js'),ownerId:'qualification'});
    const initial = await manager.loadStore(); key=initial.key;
    opened = await openEncryptedMailDatabase({path:initial.databasePath,key}); migrateMailSchema(opened);
    const repository=new MailRepository(opened,'qualification');repository.createAccount({id:'a',provider:'gmail',displayName:'Synthetic'});
    const locator={provider:'gmail',messageId:'m'};repository.ingestMessage('a',{locator,subject:marker,rfcMessageId:null,memberships:[]});
    const content=new MailContentStore(opened,'qualification'); const raw=await content.writePart('a',locator,{kind:'raw',maxBytes:1024},[Buffer.from(marker)]);
    await content.writePart('a',locator,{kind:'attachment',partId:'a',maxBytes:1024},[Buffer.from(marker)]);
    new MailSearchStore(opened,'qualification').rebuild({accountId:'a'});
    for(const path of [initial.databasePath,initial.databasePath+'-wal'])assert.equal((await fs.readFile(path)).includes(Buffer.from(marker)),false);
    assert.equal(opened.get('PRAGMA temp_store').temp_store,2);opened.close();opened=undefined;
    await manager.rotate();const rotated=await manager.loadStore();
    await assert.rejects(openEncryptedMailDatabase({path:rotated.databasePath,key}));key.fill(0);key=rotated.key;
    const backup=join(profile,'backup');await manager.exportBackup(backup,'synthetic qualification recovery passphrase');
    const clean=createMailStoreMaintenance({directory:join(profile,'recovered'),safeStorage,windowsAcl:enforceMailWindowsAcl,executable:{kind:'electron',path:process.execPath},entryPoint:join(build,'mail/runtime/maintenance-worker.js'),ownerId:'qualification'});
    await clean.restoreBackup(backup,'synthetic qualification recovery passphrase');const restored=await clean.loadStore();key.fill(0);key=restored.key;
    opened=await openEncryptedMailDatabase({path:restored.databasePath,key});
    assert.equal(Buffer.concat([...new MailContentStore(opened,'qualification').read('a',raw.id)]).toString(),marker);
    assert.equal(opened.get("SELECT count(*) AS n FROM mail_search_fts WHERE mail_search_fts MATCH 'synthetic_mail_platform_private_marker'").n,1);
    opened.close();opened=undefined;
    await fs.writeFile(join(profile,'qualification-result.json'),JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron,vault:true,cipher:true,wal:true,tempMemory:true,fts:true,rotation:true,recovery:true,privatePath:restored.databasePath}));
    app.exit(0);
  } catch { process.stderr.write('mail_platform_qualification_failed\n');app.exit(1); }
  finally {opened?.close();key?.fill(0);}
}).catch(()=>app.exit(1));
