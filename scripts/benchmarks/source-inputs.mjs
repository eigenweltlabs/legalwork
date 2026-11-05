import { cp } from "node:fs/promises";
import { join } from "node:path";
import { extractFullArtifact } from "./artifacts.mjs";
import { fingerprintTree, inside, privateWrite, readJson } from "./evidence.mjs";

export async function snapshotTaskInputs(directory, evidence, provenance = {capturePhase:"before-agent-prompt",exactAgentFilesystemSnapshot:true}) {
  const root=join(evidence,"inputs");
  await cp(directory,root,{recursive:true,errorOnExist:true,force:false});
  const manifest={capturedAt:new Date().toISOString(),...provenance,...await fingerprintTree(root)};
  if(manifest.entries.some(entry=>entry.symlink))throw new Error("Task input snapshot contains a symlink; no outside-file hydration is permitted");
  await privateWrite(join(evidence,"inputs-manifest.json"),manifest);
  return {sha256:manifest.sha256,files:manifest.entries.length,capturePhase:manifest.capturePhase,exactAgentFilesystemSnapshot:manifest.exactAgentFilesystemSnapshot};
}

/** Judges use full retained sources, never inferred evidence or agent answers. */
export async function readJudgeSources(evidence) {
  const manifest=await readJson(join(evidence,"inputs-manifest.json"));
  const root=join(evidence,"inputs");
  const actual=await fingerprintTree(root);
  if(manifest.sha256!==actual.sha256 || actual.entries.some(entry=>entry.symlink))throw new Error("Judge source integrity changed or contains an unsupported link");
  const documents=[];
  for(const file of actual.entries) {
    const extracted=await extractFullArtifact(inside(root,file.path));
    documents.push({name:file.path,sha256:file.sha256,bytes:file.bytes,text:extracted.text,extractionLimitations:extracted.limitations});
  }
  return {provenance:{capturePhase:manifest.capturePhase,exactAgentFilesystemSnapshot:manifest.exactAgentFilesystemSnapshot,treeSha256:manifest.sha256,...(manifest.pinnedSource?{pinnedSource:manifest.pinnedSource}:{})},documents};
}
