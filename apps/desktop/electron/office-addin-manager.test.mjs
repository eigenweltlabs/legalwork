import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lw-office-trust-notification-"));
  const dist = join(root, "dist"), data = join(root, "profile");
  await Promise.all([mkdir(dist), mkdir(data)]);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(dist, "word-addin.js"), 'export const buildWordAddinManifest=()=>"owned-fixture";export const loadOfficeConnectionToken=async()=>"fixture";');
  const cert = join(root, "cert.mjs"), platform = join(root, "platform.mjs");
  await writeFile(cert, 'export const ensureLocalCert=async()=>({leafCertPath:"unused",caCertPath:"unused"});export const leafCertValid=()=>true;export const officeAddinCertToolAvailable=()=>true;export const caFingerprint=()=>"fixture";');
  await writeFile(platform, `export const state={trusted:false,trustOK:true,untrustOK:true,manifestOK:true};export function createOfficeAddinPlatformBackend(){return{listApps:()=>[{id:'word',label:'Word',installed:true}],caTrusted:()=>state.trusted,trustCa:()=>({ok:state.trustOK,error:state.trustOK?undefined:'declined'}),untrustCa:()=>({ok:state.untrustOK,error:state.untrustOK?undefined:'declined'}),manifestHost:()=> 'Word',writeManifest:()=>({ok:state.manifestOK,error:state.manifestOK?undefined:'fixture manifest failure'}),removeManifest:()=>({ok:true})}}`);
  // Link the actual manager to pure test backends. These tests never generate,
  // import, remove or inspect certificates in any real OS trust store.
  const source = await readFile(new URL("./office-addin-manager.mjs", import.meta.url), "utf8");
  assert.equal(source.split('"./office-addin-cert.mjs"').length, 2);
  assert.equal(source.split('"./office-addin-platform.mjs"').length, 2);
  const linked = source.replace('"./office-addin-cert.mjs"', JSON.stringify(pathToFileURL(cert).href)).replace('"./office-addin-platform.mjs"', JSON.stringify(pathToFileURL(platform).href));
  const { createOfficeAddinManager } = await import(`data:text/javascript;base64,${Buffer.from(linked).toString("base64")}`);
  const { state } = await import(pathToFileURL(platform).href);
  const events = [];
  const manager = createOfficeAddinManager({ app: { getPath: () => data, getVersion: () => "0.0.0" }, locateServerDist: () => dist, locatePaneDist: () => null,
    requestServerRestart: async () => { events.push("restart"); }, onTrustStoreChanged: () => { events.push("trust-changed"); } });
  return { state, manager, events, close: () => rm(root, { recursive: true, force: true }) };
}

test("successful explicit trust invalidates before a later manifest failure, without a restart or certificate IPC", async () => {
  const f = await fixture();
  try {
    f.state.manifestOK = false;
    const result = await f.manager.install("word");
    assert.equal(result.ok, false); assert.match(result.error, /manifest failure/);
    assert.deepEqual(f.events, ["trust-changed"]);
  } finally { await f.close(); }
});

test("skipped or failed OS trust never emits the successful-change notification", async () => {
  for (const trusted of [true, false]) {
    const f = await fixture();
    try {
      f.state.trusted = trusted; f.state.trustOK = false;
      const result = await f.manager.install("word");
      assert.equal(result.ok, trusted);
      assert.deepEqual(f.events, trusted ? ["restart"] : []);
    } finally { await f.close(); }
  }
});

test("only a successful explicit final uninstall invalidates trust, preserving denied uninstall state", async () => {
  const f = await fixture();
  try {
    f.state.trusted = true;
    assert.equal((await f.manager.install("word")).ok, true); f.events.length = 0;
    f.state.untrustOK = false;
    assert.equal((await f.manager.uninstall("word")).ok, false);
    assert.deepEqual(f.events, []); assert.equal(f.manager.readState().apps.word, true);
    f.state.untrustOK = true;
    assert.equal((await f.manager.uninstall("word")).ok, true);
    assert.deepEqual(f.events, ["trust-changed", "restart"]); assert.equal(f.manager.readState().apps.word, false);
  } finally { await f.close(); }
});
