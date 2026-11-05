import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareInputEntries, mirrorTaskArchive, privateProcess, shellQuote } from "./remote-files.mjs";
import { fingerprintTree } from "./evidence.mjs";

test("source receipt rejects a changed tail or any source link without changing content", () => {
  const entry = {path:"contract.txt",bytes:2_000_000,sha256:"a".repeat(64)};
  assert.equal(compareInputEntries([entry],[{...entry}]),true);
  assert.throws(()=>compareInputEntries([entry],[{...entry,sha256:"b".repeat(64)}]),/differ/);
  assert.throws(()=>compareInputEntries([entry],[{...entry,symlink:"/outside"}]),/differ/);
  assert.throws(()=>compareInputEntries([entry],[]),/differ/);
  assert.equal(shellQuote("$(echo leaked); it's literal"),"'$(echo leaked); it'\\''s literal'");
});

test("full remote artifact mirrors retain tails and link provenance without hydrating host files", async () => {
  const root=await mkdtemp(join(tmpdir(),"legalwork-remote-artifacts-"));
  try {
    const source=join(root,"source");await mkdir(source);
    const full="§".repeat(700_000)+"FULL-REMOTE-TAIL";
    await writeFile(join(source,"output.txt"),full);
    const forbidden=join(root,"controller-private.txt");await writeFile(forbidden,"private controller sentinel");
    await symlink(forbidden,join(source,"untrusted-link"));
    const archive=join(root,"results.tar");
    await privateProcess("tar",["-cf",archive,"-C",source,"."],{evidence:join(root,"tar"),env:{...process.env,COPYFILE_DISABLE:"1"}});
    const original=await readFile(archive);
    const mirror=join(root,"mirror");const evidence=join(root,"evidence");await mkdir(evidence);
    const receipt=await mirrorTaskArchive(archive,mirror,evidence);
    assert.equal(await readFile(join(mirror,"output.txt"),"utf8"),full);
    assert.equal(receipt.outputCaps,false);
    assert.equal(receipt.nonHydratedEntries.length,1);
    assert.equal(receipt.nonHydratedEntries[0].link,forbidden);
    await assert.rejects(readFile(join(mirror,"untrusted-link")),/ENOENT/);
    assert.equal(await readFile(forbidden,"utf8"),"private controller sentinel");
    assert.deepEqual(await readFile(archive),original);
    assert.equal((await fingerprintTree(mirror)).entries.length,1);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("malicious remote archive traversal fails and never creates its outside member", async () => {
  const root=await mkdtemp(join(tmpdir(),"legalwork-remote-traversal-"));
  try {
    const archive=join(root,"malicious.tar");
    await privateProcess("python3",["-c","import io,sys,tarfile\nwith tarfile.open(sys.argv[1],'w') as a:\n m=tarfile.TarInfo('../outside');m.size=4;a.addfile(m,io.BytesIO(b'evil'))",archive],{evidence:join(root,"generate")});
    const evidence=join(root,"evidence");await mkdir(evidence);
    await assert.rejects(mirrorTaskArchive(archive,join(root,"mirror"),evidence),/failed/);
    await assert.rejects(readFile(join(root,"outside")),/ENOENT/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
