// Supplement the normal desktop package test command without repeating its suites.
import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const directory='apps/desktop/electron';
const normal=JSON.parse(await readFile('apps/desktop/package.json','utf8')).scripts.test.split(/\s+/);
const names=(await readdir(directory)).filter(name=>name.startsWith('mail-')&&name.endsWith('.test.mjs')&&!normal.includes('electron/'+name)).sort();
console.log(JSON.stringify({additionalDesktopQualificationSuites:names}));
if(!names.length)throw Error('Expected explicit supplemental mail suites');
const result=spawnSync(process.execPath,['--test','--test-concurrency=2',...names.map(name=>join(directory,name))],{stdio:'inherit'});
process.exitCode=result.status??1;
