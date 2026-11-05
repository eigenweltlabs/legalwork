import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { privateWrite } from "./evidence.mjs";
import { snapshotTaskInputs, readJudgeSources } from "./source-inputs.mjs";

test("full pre-prompt source bytes survive source edits and judges fail changed evidence",async()=> {
  const root=await mkdtemp(join(tmpdir(),"legalwork-judge-sources-"));
  const input=join(root,"project");const evidence=join(root,"evidence");
  const tail="source ".repeat(30000)+"SOURCE-TAIL";
  try {
    await privateWrite(join(input,"documents/source.txt"),tail);
    const snapshot=await snapshotTaskInputs(input,evidence);
    assert.equal(snapshot.capturePhase,"before-agent-prompt");
    assert.equal(snapshot.files,1);
    await privateWrite(join(input,"documents/source.txt"),"agent modified source");
    const sources=await readJudgeSources(evidence);
    assert.equal(sources.documents[0].text,tail);
    assert.equal(sources.provenance.exactAgentFilesystemSnapshot,true);
    await privateWrite(join(evidence,"inputs/documents/source.txt"),"modified evidence");
    await assert.rejects(()=>readJudgeSources(evidence),/integrity changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});
