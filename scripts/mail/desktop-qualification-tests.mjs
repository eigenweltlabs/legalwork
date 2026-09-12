// Complete mail desktop boundary coverage plus its lifecycle/session/package dependencies.
import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const directory='apps/desktop/electron';
const dependencies=['power-lifecycle.test.mjs','opencode-state-dir.test.mjs','workspace-store.test.mjs','updater.test.mjs','packaged-server-deps.test.mjs','packaged-plugin-bundles.test.mjs','packaged-icons.test.mjs','packaged-sidecars.test.mjs'];
const names=(await readdir(directory)).filter(name=>name.startsWith('mail-')&&name.endsWith('.test.mjs')||dependencies.includes(name)).sort();
console.log(JSON.stringify({desktopQualificationSuites:names}));
const result=spawnSync(process.execPath,['--test','--test-concurrency=2',...names.map(name=>join(directory,name))],{stdio:'inherit'});
process.exitCode=result.status??1;
