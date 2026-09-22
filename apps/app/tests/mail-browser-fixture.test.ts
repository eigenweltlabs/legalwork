import {spawnSync} from 'node:child_process';
import {test,expect,mock} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildBrowserFixture,electronDisplayEnvironment} from './fixtures/build-browser';

test('browser fixtures resolve real modules outside the mocked test process',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-browser-build-'));
 try{
  const dependency=join(root,'dependency.ts'),entry=join(root,'entry.ts');
  await writeFile(dependency,"export const marker='REAL_BROWSER_MODULE';");
  await writeFile(entry,"export {marker} from './dependency';");
  mock.module(dependency,()=>({marker:'MOCKED_TEST_MODULE'}));
  expect((await import(dependency)).marker).toBe('MOCKED_TEST_MODULE');
  await mkdir(join(root,'out'));
  await buildBrowserFixture({entrypoints:[entry],outdir:join(root,'out'),format:'esm',naming:'fixture.js'});
  const output=await readFile(join(root,'out/fixture.js'),'utf8');
  expect(output).toContain('REAL_BROWSER_MODULE');
  expect(output).not.toContain('MOCKED_TEST_MODULE');
 }finally{await rm(root,{recursive:true,force:true});}
});


test('restricted Electron fixture environments preserve only Linux display access',()=>{
 const source={DISPLAY:':91',XAUTHORITY:'/synthetic/xauth',LEGALWORK_HOST_TOKEN:'must-not-inherit',ELECTRON_RUN_AS_NODE:'must-not-inherit'};
 const environment=electronDisplayEnvironment(source,'linux');
 expect(environment).toEqual({DISPLAY:source.DISPLAY,XAUTHORITY:source.XAUTHORITY});
 expect(electronDisplayEnvironment(source,'darwin')).toEqual({});
 expect(electronDisplayEnvironment(source,'win32')).toEqual({});
 const node=Bun.which('node');if(!node)throw Error('Node required for child environment regression');
 const child=spawnSync(node,['-e','process.stdout.write(JSON.stringify(process.env))'],{env:environment,encoding:'utf8',timeout:5000});
 expect(child.error).toBeUndefined();expect(child.status).toBe(0);
 const received=JSON.parse(child.stdout);expect(received.DISPLAY).toBe(source.DISPLAY);expect(received.XAUTHORITY).toBe(source.XAUTHORITY);
 expect(received.LEGALWORK_HOST_TOKEN).toBeUndefined();expect(received.ELECTRON_RUN_AS_NODE).toBeUndefined();
});
