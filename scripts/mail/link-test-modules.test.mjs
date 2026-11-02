import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,realpath,readlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {linkTestModules,unlinkTestModules,removeTestTree} from './link-test-modules.mjs';

for(const cleanup of ['recursive control','explicit unlink','entry cleanup'])test(`temporary module links preserve targets after ${cleanup}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'mail-module-links-'));
  try{
    const source=join(root,'workspace/apps/server/node_modules');await mkdir(join(source,'@fixture'),{recursive:true});
    for(const name of ['plain','@fixture/scoped']){
      const pkg=join(root,'workspace/node_modules/.pnpm',name.replace('/','+'),'node_modules',name);await mkdir(pkg,{recursive:true});
      await writeFile(join(pkg,'package.json'),JSON.stringify({name,type:'module',exports:'./index.js'}));await writeFile(join(pkg,'index.js'),'export default 17;');
      const entry=join(source,name);await symlink(relative(join(entry,'..'),pkg),entry,'dir');
    }
    const temporary=join(root,'isolated');await mkdir(temporary);const destination=join(temporary,'node_modules');
    await linkTestModules(source,destination,'win32');
    for(const name of ['plain','@fixture/scoped']){
      assert.equal(await realpath(join(destination,name)),await realpath(join(source,name)));
      assert.equal(isAbsolute(await readlink(join(destination,name))),true);
    }
    await writeFile(join(temporary,'probe.mjs'),"import a from 'plain';import b from '@fixture/scoped';if(a+b!==34)throw Error('bad module');");
    const result=spawnSync(process.execPath,[join(temporary,'probe.mjs')],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
    if(cleanup==='explicit unlink'){await unlinkTestModules(destination);await removeTestTree(temporary);}
    else if(cleanup==='entry cleanup')await removeTestTree(temporary);
    else await rm(temporary,{recursive:true});
    for(const name of ['plain','@fixture/scoped'])assert.equal(await readFile(join(source,name,'index.js'),'utf8'),'export default 17;');
    await unlinkTestModules(destination); // Missing fixture links are harmless during failed setup cleanup.
  }finally{await rm(root,{recursive:true,force:true});}
});
