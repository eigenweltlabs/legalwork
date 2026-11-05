import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyAdmission, verifySuiteAdmission, verifyObserverRegistration, verifyCaptureTransport, nativePackageIdentityContract } from "./packaged-environment.mjs";
import { sha256 } from "./evidence.mjs";

test("remote capture distinguishes exact host and guest ports and fails closed on the wrong reverse", () => {
  const capture = { baseURL: "http://127.0.0.1:39190", localToken: "test-local-only" };
  const mapping = { hostPort: 39190, guestPort: 39180 };
  const command = "gcloud compute ssh owned -- -N -L 39400:127.0.0.1:40000 -R 127.0.0.1:39180:127.0.0.1:39190";
  assert.deepEqual(verifyCaptureTransport(capture, mapping, command), { hostBaseURL: capture.baseURL, guestBaseURL: "http://127.0.0.1:39180", ...mapping, mechanism: "exact-owned-loopback-ssh-reverse-forward" });
  assert.throws(() => verifyCaptureTransport(capture, undefined, command), /Explicit/);
  assert.throws(() => verifyCaptureTransport(capture, { hostPort: 39191, guestPort: 39180 }, command), /controller URL/);
  assert.throws(() => verifyCaptureTransport(capture, { hostPort: 39190, guestPort: 39181 }, command), /reverse/);
  assert.throws(() => verifyCaptureTransport(capture, mapping, command.replace("-R", "-L")), /reverse/);
  assert.throws(() => verifyCaptureTransport(capture, mapping, command.replace(":39190", ":39191")), /reverse/);
  assert.throws(() => verifyCaptureTransport(capture, mapping, command + " -R 127.0.0.1:39180:127.0.0.1:39191"), /ambiguous/);
  assert.throws(() => verifyCaptureTransport(capture, mapping, command.replace("127.0.0.1:39180", "0.0.0.0:39180")), /reverse/);
  for (const baseURL of ["https://127.0.0.1:39190", "http://localhost:39190", "http://127.0.0.1:39190/v1", "http://127.0.0.1:39190?secret=value"]) assert.throws(() => verifyCaptureTransport({ ...capture, baseURL }, mapping, command), /controller URL/);
});

test("paid guest admission binds reviewed complete isolation, exact runtime/instance and original cost lease", () => {
  const isolationBytes=JSON.stringify({state:"passed",stage:"fresh-normal-profile-ready",normalProfileInitiallyEmpty:true,profile:"/guest/normal/electron",workspace:"/guest/normal/workspace",instanceID:"owned-vm",runtimeManifestSha256:"actual-runtime",paidModelCalls:0,controllerExpectationsInGuest:false});
  const identity={runtimeManifestSha256:"actual-runtime",isolation:{receiptSha256:sha256(isolationBytes),profile:"/guest/normal/electron",workspace:"/guest/normal/workspace"},cloud:{terminationTime:"2026-10-25T01:19:28Z"}};
  const approval={allowPaid:true,profile:"/guest/normal/electron",workspace:"/guest/normal/workspace",instanceID:"owned-vm",runtimeManifestSha256:"actual-runtime",isolationReceiptSha256:sha256(isolationBytes)};
  const options={approval,isolationBytes,identity,instanceID:"owned-vm",now:Date.parse("2026-10-24T23:00:00Z")};
  assert.equal(verifyAdmission(options),true);
  for(const changed of [{...approval,allowPaid:false},{...approval,instanceID:"other-vm"},{...approval,runtimeManifestSha256:"other-runtime"},{...approval,isolationReceiptSha256:"unreviewed"}])assert.throws(()=>verifyAdmission({...options,approval:changed}),/reviewed/);
  assert.throws(()=>verifyAdmission({...options,isolationBytes:JSON.stringify({state:"pending"})}),/reviewed/);
  for(const changed of [{...approval,profile:"/guest/probe/electron"},{...approval,workspace:"/guest/probe/workspace"}])assert.throws(()=>verifyAdmission({...options,approval:changed}),/profile and workspace/);
  const probeBytes=JSON.stringify({...JSON.parse(isolationBytes),stage:"deterministic-canary",normalProfileInitiallyEmpty:false});assert.throws(()=>verifyAdmission({...options,isolationBytes:probeBytes,approval:{...approval,isolationReceiptSha256:sha256(probeBytes)},identity:{...identity,isolation:{...identity.isolation,receiptSha256:sha256(probeBytes)}}}),/profile and workspace/);
  assert.throws(()=>verifyAdmission({...options,now:Date.parse("2026-10-25T01:19:28Z")}),/lease has expired/);
});

test("empty observer registration proves exact payload bytes and cannot borrow another producer", () => {
  const payload={observerInstance:"owned",sequence:0,previousSha256:null,location:"/task",runtimeKind:"legacy-v1",phase:"observer.ready",at:"frozen"};
  const registration={payload,recordSha256:sha256(JSON.stringify(payload))};
  const health={observerInstance:"owned",location:"/task",runtimeKind:"legacy-v1",registrationSha256:registration.recordSha256};
  assert.equal(verifyObserverRegistration(registration,health),true);
  for(const changed of [{...payload,at:"changed"},{...payload,observerInstance:"other"},{...payload,location:"/other"},{...payload,phase:"after"}])assert.throws(()=>verifyObserverRegistration({...registration,payload:changed},health),/registration payload/);
  assert.throws(()=>verifyObserverRegistration(registration,{...health,registrationSha256:"forged"}),/registration payload/);
});

test("paid admission enforces exact controller suite bytes and complete reviewed task set before every Send", () => {
  const suite = { id: "matched", model: { id: "unchanged" }, tasks: [{ id: "legal-task", prompt: "Only reviewed input" }] };
  const suiteBytes = Buffer.from(JSON.stringify(suite, null, 2));
  const approval = { suiteSha256: sha256(suiteBytes), suiteCanonicalSha256: sha256(JSON.stringify(suite)), taskIDs: ["legal-task"] };
  assert.equal(verifySuiteAdmission({ approval, suiteBytes, suite }), true);
  assert.equal(verifySuiteAdmission({ approval, suiteBytes, suite, taskID: "legal-task" }), true);
  assert.throws(() => verifySuiteAdmission({ approval, suiteBytes, suite: { ...suite, tasks: [{ id: "legal-task", prompt: "Unreviewed hint" }] } }), /suite bytes/);
  assert.throws(() => verifySuiteAdmission({ approval, suiteBytes: Buffer.from(JSON.stringify(suite)), suite }), /suite bytes/);
  assert.throws(() => verifySuiteAdmission({ approval: { ...approval, suiteCanonicalSha256: "unreviewed" }, suiteBytes, suite }), /canonical identity/);
  for (const taskIDs of [[], ["other"], ["legal-task", "other"], ["legal-task", "legal-task"]]) assert.throws(() => verifySuiteAdmission({ approval: { ...approval, taskIDs }, suiteBytes, suite }), /reviewed task/);
  assert.throws(() => verifySuiteAdmission({ approval, suiteBytes, suite, taskID: "other" }), /reviewed task/);
  assert.throws(() => verifySuiteAdmission({ approval, suiteBytes }), /suite bytes/);
});

test("native package identity keeps original sealed proof and exact compiled-selected five files, never a legacy alias",()=>{
 const version='2.1.4-legalwork.http-policy.3',artifactId='c'.repeat(64),directory=`resources/opencode-engine/${artifactId}/linux-x64-baseline`,hash='a'.repeat(64),pin='b'.repeat(64),root='/opt/lw-v2';
 const receipt={package:root,engine:{path:root+'/'+directory+'/opencode',sha256:hash},asarSha256:pin,sourceCommit:'fdb',guestSourceArchiveSha256:'guest-source',normalSelectorSha256:'compiled-selector',independentDistributionManifestSha256:artifactId,files:['LICENSE','NOTICE','SHA256SUMS','opencode','provenance.json'].map(name=>({path:directory+'/'+name,type:'file',uid:0,gid:0,nlink:1,size:10,mode:name==='opencode'?'0o755':'0o644',sha256:hash}))};
 const bytes=JSON.stringify(receipt);const manifest={nativePackage:{packageReceiptSha256:sha256(bytes),selectionSha256:receipt.normalSelectorSha256,distributionManifestSha256:receipt.independentDistributionManifestSha256},source:{commit:'fdb',archiveSha256:'guest-source'},runtime:{engineVersion:version,engineRelativePath:directory+'/opencode',engineBinarySha256:hash},build:{asar:{sha256:pin}}};const options={runtimeRoot:root,packageReceiptSha256:sha256(bytes),packageReceiptGuestPath:'/root/normal-package-receipt.json'};
 const contract=nativePackageIdentityContract(manifest,bytes,options);assert.equal(contract.engineRelativePath,directory+'/opencode');assert.equal(contract.files.length,5);assert.equal(contract.packageReceiptSha256,sha256(bytes));assert.equal(contract.packageReceiptGuestPath,options.packageReceiptGuestPath);
 assert.throws(()=>nativePackageIdentityContract(manifest,bytes+' ',options),/original native package receipt pin/);
 for(const changed of [{...manifest,runtime:{...manifest.runtime,engineRelativePath:`resources/opencode-engine/${version}/linux-x64-baseline/opencode`}},{...manifest,runtime:{...manifest.runtime,engineRelativePath:'resources/sidecars/opencode'}},{...manifest,runtime:{...manifest.runtime,engineRelativePath:'../opencode'}},{...manifest,runtime:{...manifest.runtime,engineBinarySha256:pin}},{...manifest,runtime:{...manifest.runtime,engineVersion:'2.1.4'}},{...manifest,source:{...manifest.source,commit:'other-source'}},{...manifest,nativePackage:{...manifest.nativePackage,selectionSha256:'uncompiled-selector'}},{...manifest,nativePackage:{...manifest.nativePackage,distributionManifestSha256:'other-manifest'}},{...manifest,build:{asar:{sha256:hash}}}])assert.throws(()=>nativePackageIdentityContract(changed,bytes,options),/identities differ/);
 for(const files of [receipt.files.slice(1),[...receipt.files,receipt.files[0]],receipt.files.map((e,i)=>i?e:{...e,type:'symlink'}),receipt.files.map((e,i)=>i?e:{...e,uid:1002}),receipt.files.map((e,i)=>i?e:{...e,mode:'0o666'}),receipt.files.map((e,i)=>i?e:{...e,nlink:2}),receipt.files.map((e,i)=>i?e:{...e,size:-1}),receipt.files.map((e,i)=>i?e:{...e,mode:'invalid'}),receipt.files.map((e,i)=>i?e:{...e,path:directory+'/nested/LICENSE'})]){
  const changed=JSON.stringify({...receipt,files}),packageReceiptSha256=sha256(changed);assert.throws(()=>nativePackageIdentityContract({...manifest,nativePackage:{...manifest.nativePackage,packageReceiptSha256}},changed,{...options,packageReceiptSha256}),/five-file inventory/);
 }
 assert.throws(()=>nativePackageIdentityContract(manifest,bytes,{...options,runtimeRoot:'/opt/other'}),/identities differ/);
});
