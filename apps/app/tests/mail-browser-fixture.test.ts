import {test,expect,mock} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildBrowserFixture} from './fixtures/build-browser';

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
