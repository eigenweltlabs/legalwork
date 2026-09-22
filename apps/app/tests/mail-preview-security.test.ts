import {test,expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('mail image preview security does not initialize shared stores without browser storage',()=>{
  const result=spawnSync(process.execPath,['test',resolve(import.meta.dir,'fixtures/mail-preview-security.fixture.ts')],{encoding:'utf8',timeout:15000});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(result.stderr||result.stdout);
  expect(result.stderr).toContain('1 pass');
});
