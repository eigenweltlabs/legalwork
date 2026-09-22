// TEMPORARY qualification-branch instrumentation, never merged or published.
import {readFile, writeFile, copyFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const main='apps/desktop/electron/main.mjs', updater='apps/desktop/electron/updater.mjs';
let source=await readFile(main,'utf8');
const anchor='    void ensureAutoUpdater();';
assert.equal(source.split(anchor).length,2);
source=source.replace(anchor,`    await ensureAutoUpdater();
    await (await import('./mail-signed-qualification.mjs')).qualifySignedApp({app, win, safeStorage});`);
await writeFile(main,source);
await copyFile('scripts/mail/signed-qualification/app-probe.mjs','apps/desktop/electron/mail-signed-qualification.mjs');
source=await readFile(updater,'utf8');
const marker='export const ELECTRON_UPDATER_FEEDS = Object.freeze({';
assert(source.includes(marker));
source=source.replace(marker,`const qualificationFeed = JSON.parse(readFileSync(path.join(process.env.HOME, 'Library/Application Support/com.eigenweltlabs.legalwork/mail-signed-qualification.json'), 'utf8')).feed;
const qualificationUrl = new URL(qualificationFeed);
if (qualificationUrl.protocol !== 'http:' || qualificationUrl.hostname !== '127.0.0.1' || !qualificationUrl.port || qualificationUrl.username || qualificationUrl.password) throw Error('Qualification feed must be loopback-only');
${marker}`);
for(const value of ['"https://eigenweltlabs.com/legalwork/update"','"https://github.com/eigenweltlabs/legalwork/releases/download/alpha-windows-latest"','"https://github.com/eigenweltlabs/legalwork/releases/download/alpha-macos-latest"','"https://github.com/eigenweltlabs/legalwork/releases/latest/download"']) {assert(source.includes(value),'Production feed changed: review qualification substitution');source=source.replaceAll(value,'qualificationFeed');}
await writeFile(updater,source);
