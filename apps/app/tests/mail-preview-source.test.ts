import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('mail preview persistence and lifetime checks use initialized browser storage',()=>{
  // Other shared tests import the store without browser storage. Zustand captures
  // that absence at module initialization, so exercise persistence in a fresh realm.
  const result=spawnSync(process.execPath,['test',resolve(import.meta.dir,'fixtures/mail-preview-source.fixture.ts')],{encoding:'utf8',timeout:15000});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(result.stderr||result.stdout);
  expect(result.stderr).toContain('2 pass');
});
