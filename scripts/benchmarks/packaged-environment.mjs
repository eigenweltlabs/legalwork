// Host-only adapter for a disposable, separately identified Linux desktop.
// No suite, expectations, judging code, or production gateway key enters it.
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { verifyToolJournal, scopeToolJournals } from "./tool-journal.mjs";
import { verifyWriteOnlyAcknowledgments } from "./write-only-tool-journal.mjs";
import { createSshFiles } from "./remote-files.mjs";
import { privateWrite, readJson, sha256 } from "./evidence.mjs";
import { normalUiFocusBinding } from "./normal-ui-focus.mjs";
import { physicalRendererVerificationPython } from "./packaged-renderer.mjs";

function loopback(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid explicit loopback tunnel port");
  return `http://127.0.0.1:${port}`;
}

export function verifyObserverRegistration(registration, health) {
  const payload=registration?.payload;
  if(!payload || payload.phase!=="observer.ready" || payload.sequence!==0 || payload.previousSha256!==null
    || payload.observerInstance!==health.observerInstance || payload.location!==health.location || payload.runtimeKind!==health.runtimeKind
    || sha256(JSON.stringify(payload))!==registration.recordSha256 || registration.recordSha256!==health.registrationSha256)throw new Error("Private observer registration payload/hash differs");
  return true;
}

export function verifyAdmission({ approval, isolationBytes, identity, instanceID, now = Date.now() }) {
  const isolation = JSON.parse(isolationBytes);
  if (approval.allowPaid !== true || approval.instanceID !== instanceID || isolation.instanceID !== instanceID || approval.isolationReceiptSha256 !== sha256(isolationBytes)
    || approval.runtimeManifestSha256 !== identity.runtimeManifestSha256 || isolation.runtimeManifestSha256 !== identity.runtimeManifestSha256
    || isolation.state !== "passed" || isolation.paidModelCalls !== 0 || isolation.controllerExpectationsInGuest !== false
    || identity.isolation.receiptSha256 !== sha256(isolationBytes)) throw new Error("Root-reviewed exact guest isolation/runtime receipt is required before model admission");
  if (isolation.stage !== "fresh-normal-profile-ready" || isolation.normalProfileInitiallyEmpty !== true
    || !isolation.profile || !isolation.workspace || isolation.profile !== identity.isolation.profile || isolation.workspace !== identity.isolation.workspace
    || approval.profile !== isolation.profile || approval.workspace !== isolation.workspace) throw new Error("Root-reviewed fresh normal profile and workspace binding is required before paid admission");
  if (!Number.isFinite(Date.parse(identity.cloud.terminationTime)) || now >= Date.parse(identity.cloud.terminationTime)) throw new Error("The explicit cloud cost lease has expired; no task was admitted");
  return true;
}

export function verifySuiteAdmission({ approval, suiteBytes, suite, taskID }) {
  if (!suiteBytes || !suite || approval.suiteSha256 !== sha256(suiteBytes)
    || approval.suiteCanonicalSha256 !== sha256(JSON.stringify(suite))
    || JSON.stringify(JSON.parse(suiteBytes)) !== JSON.stringify(suite)) throw new Error("The exact root-reviewed controller suite bytes and parsed canonical identity are required before paid admission");
  const tasks = suite.tasks?.map(task => task.id);
  if (!Array.isArray(tasks) || !tasks.length || tasks.some(id => typeof id !== "string" || !id)
    || new Set(tasks).size !== tasks.length || !Array.isArray(approval.taskIDs)
    || JSON.stringify([...approval.taskIDs].sort()) !== JSON.stringify([...tasks].sort())
    || taskID !== undefined && !tasks.includes(taskID)) throw new Error("Paid admission is restricted to the exact reviewed task identities");
  return true;
}

export function verifyCaptureTransport(capture, mapping, command) {
  if (!mapping || !Number.isInteger(mapping.hostPort) || !Number.isInteger(mapping.guestPort)) throw new Error("Explicit host/guest capture-port mapping is required");
  const hostBaseURL = loopback(mapping.hostPort), guestBaseURL = loopback(mapping.guestPort);
  if (capture?.baseURL !== hostBaseURL) throw new Error("Capture controller URL differs from the reviewed host port");
  const args = command.trim().split(/\s+/);
  const reverses = args.flatMap((value, index) => value === "-R" ? [args[index + 1]] : []);
  const expected = `127.0.0.1:${mapping.guestPort}:127.0.0.1:${mapping.hostPort}`;
  if (reverses.filter(value => value === expected).length !== 1
    || reverses.some(value => value !== expected && value?.startsWith(`127.0.0.1:${mapping.guestPort}:`))) throw new Error("Exact owned SSH reverse capture forward is missing or ambiguous");
  return { hostBaseURL, guestBaseURL, hostPort: mapping.hostPort, guestPort: mapping.guestPort, mechanism: "exact-owned-loopback-ssh-reverse-forward" };
}

// Controller-only normal-package observation. The original sealed package
// receipt is independently pinned; this is no executable trust override.
export function nativePackageIdentityContract(manifest, receiptBytes, options) {
  const receipt = JSON.parse(receiptBytes);
  if (!options || sha256(receiptBytes) !== options.packageReceiptSha256
    || manifest.nativePackage?.packageReceiptSha256 !== options.packageReceiptSha256) throw new Error("Exact original native package receipt pin required");
  const version = manifest.runtime?.engineVersion, artifactId = manifest.nativePackage.distributionManifestSha256;
  const relative = `resources/opencode-engine/${artifactId}/linux-x64-baseline/opencode`;
  if (!/^[a-f0-9]{64}$/.test(artifactId ?? "") || !/^2\.1\.4-legalwork\.http-policy\.3$/.test(version ?? "") || manifest.runtime.engineRelativePath !== relative
    || receipt.package !== options.runtimeRoot || receipt.engine.path !== `${options.runtimeRoot}/${relative}`
    || receipt.engine.sha256 !== manifest.runtime.engineBinarySha256
    || receipt.asarSha256 !== manifest.build?.asar?.sha256
    || receipt.sourceCommit !== manifest.source?.commit
    || receipt.guestSourceArchiveSha256 !== manifest.source?.archiveSha256
    || receipt.normalSelectorSha256 !== manifest.nativePackage.selectionSha256
    || receipt.independentDistributionManifestSha256 !== manifest.nativePackage.distributionManifestSha256) throw new Error("Native source/compiled-selection/package identities differ");
  const directory = relative.slice(0, relative.lastIndexOf("/"));
  const files = receipt.files.filter(entry => entry.type === "file" && entry.path.startsWith(directory + "/"));
  const names = ["LICENSE", "NOTICE", "SHA256SUMS", "opencode", "provenance.json"];
  if (files.length !== 5 || JSON.stringify(files.map(entry => entry.path.slice(directory.length + 1)).sort()) !== JSON.stringify(names)
    || files.some(entry => !Number.isInteger(entry.size) || entry.size < 0 || !/^0o[0-7]{3,4}$/.test(entry.mode) || entry.uid !== 0 || entry.gid !== 0 || entry.nlink !== 1 || (Number(entry.mode) & 0o022)
      || !/^[a-f0-9]{64}$/.test(entry.sha256))
    || files.find(entry => entry.path.endsWith("/opencode"))?.sha256 !== receipt.engine.sha256) throw new Error("Exact sealed native five-file inventory required");
  return { kind: "normal-native-v2", engineRelativePath: relative, engineDirectory: directory, engineVersion: version,
    engineSha256: receipt.engine.sha256, packageReceiptSha256: options.packageReceiptSha256,
    packageReceiptGuestPath: options.packageReceiptGuestPath, files,
    selectionSha256: receipt.normalSelectorSha256, distributionManifestSha256: receipt.independentDistributionManifestSha256 };
}

export async function createPackagedEnvironment(configPath) {
  const config = await readJson(configPath);
  if (config.kind !== "isolated-linux-packaged" || !config.cloud?.instanceID || !config.guest?.workspace || !config.forwarding || !config.runtimeManifestPath || !config.isolationReceiptPath || !config.admissionReceiptPath) throw new Error("Complete private packaged environment configuration required");
  const normalFocus = config.uiFocusMode === "normal-ui-control";
  if (config.uiFocusMode !== undefined && !normalFocus || normalFocus && !config.nativePackage)
    throw new Error("Normal UI focus requires explicit native-package mode; unknown modes cannot fall back");
  const operations = join(config.controllerRoot, `transport-${Date.now()}-${randomUUID()}`);
  const files = createSshFiles({ ...config.cloud, keyPath: config.keyPath, guestWorkspace: config.guest.workspace, evidence: operations });
  let actualIdentity;
  async function verifyTunnel() {
    const command = execFileSync("ps", ["-p", String(config.forwarding.pid), "-o", "command="], { encoding: "utf8" });
    if (!command.includes(config.cloud.instance) || !command.includes("gcloud")) throw new Error("The exact owned guest tunnel process is no longer running");
    // Mapping values are also matched to the current guest discovery below.
    for (const kind of normalFocus ? ["server", "ui"] : ["server", "ui", "focus"]) {
      const mapping = config.forwarding[kind]; loopback(mapping.hostPort); loopback(mapping.guestPort);
      if (!command.includes(`${mapping.hostPort}:127.0.0.1:${mapping.guestPort}`)) throw new Error("Observed SSH command does not contain the reviewed loopback forward");
    }
    return { pid: config.forwarding.pid, instance: config.cloud.instance, checkedAt: new Date().toISOString(), mappings: config.forwarding };
  }
  return {
    files,
    async providerCapture(capture) {
      const tunnel = await verifyTunnel();
      const command = execFileSync("ps", ["-p", String(config.forwarding.pid), "-o", "command="], { encoding: "utf8" });
      const transport = verifyCaptureTransport(capture, config.captureTransport, command);
      const output = join(operations, `guest-capture-health-${randomUUID()}.json`);
      await files.python(String.raw`
import urllib.request,json,sys
request=urllib.request.Request(sys.argv[1]+'/health',headers={'Authorization':'Bearer '+sys.argv[2]})
with urllib.request.urlopen(request) as response:
 print(json.dumps({'status':response.status,'health':json.load(response)}))
`, [transport.guestBaseURL, capture.localToken], { output });
      const observed = await readJson(output);
      const health = observed.health;
      if (observed.status !== 200 || health?.ok !== true || health.budgetGuardOperational !== true
        || health.budgetEvidence?.enforcement !== "local-durable-worst-case-reservations" || health.budgetEvidence.frozen !== false) throw new Error("Actual authenticated guest capture route is not an operational budget guard");
      await privateWrite(join(operations, `provider-capture-transport-${randomUUID()}.json`), { transport, tunnel, guestHealthPath: output, verifiedAt: new Date().toISOString(), requestBodyMutation: false, paidCalls: 0 });
      return { ...capture, baseURL: transport.guestBaseURL };
    },
    async declineExternalPermission(input) {
      const {declineThroughVisibleUI}=await import("./x11-permissions.mjs");
      return declineThroughVisibleUI({config,files,...input});
    },
    async discover() {
      const tunnel = await verifyTunnel();
      const output = join(operations, `discovery-${randomUUID()}.json`);
      await files.python(String.raw`
import json,pathlib,pwd,stat,sys
root=pathlib.Path(sys.argv[1]);normal=sys.argv[3]=='normal-ui-control'
if normal and (root.is_symlink() or str(root.resolve())!=str(root) or root.stat().st_uid!=pwd.getpwnam('legalwork').pw_uid):raise RuntimeError('Normal app profile must be the exact owned unlinked directory')
def read(name):
 path=root/name
 if normal:
  s=path.lstat()
  if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=pwd.getpwnam('legalwork').pw_uid or stat.S_IMODE(s.st_mode)&0o077:raise RuntimeError('Normal discovery must be a private app-owned regular file')
 return json.loads(path.read_text())
print(json.dumps({'ui':read('legalwork-ui-control.json'),'state':read('legalwork-server-state.json'),'tokens':read('legalwork-server-tokens.json'),'focus':None if normal else read('legalwork-benchmark-ui-control.json')}))
`, [config.guest.profile, config.guest.workspace, normalFocus ? "normal-ui-control" : "legacy-focus-hook"], { output });
      const discovery = await readJson(output);
      const key = config.guest.workspace.toLowerCase();
      const port = discovery.state.workspacePorts?.[key];
      const auth = discovery.tokens.workspaces?.[key];
      if (port !== config.forwarding.server.guestPort || new URL(discovery.ui.baseUrl).hostname !== "127.0.0.1" || Number(new URL(discovery.ui.baseUrl).port) !== config.forwarding.ui.guestPort
        || !normalFocus && (new URL(discovery.focus.baseUrl).hostname !== "127.0.0.1" || Number(new URL(discovery.focus.baseUrl).port) !== config.forwarding.focus.guestPort)
        || !auth?.clientToken || !auth.hostToken) throw new Error("Actual guest discovery does not match scoped tunnel/host authorization");
      const base = loopback(config.forwarding.server.hostPort);
      const response = await fetch(`${base}/workspaces`, { headers: { authorization: `Bearer ${auth.clientToken}` } });
      if (!response.ok) throw new Error(`Actual forwarded workspace discovery HTTP ${response.status}`);
      const inventory = await response.json();
      const matches = inventory.items?.filter(item => item.path === config.guest.workspace) ?? [];
      if (matches.length !== 1) throw new Error("The exact guest workspace is not uniquely registered");
      await privateWrite(join(operations, "connection-mapping.json"), { tunnel, workspace: matches[0], disclosure: "Only authenticated guest loopback services are forwarded; credentials retained privately on controller." });
      const connection = { base, token: auth.clientToken, hostToken: auth.hostToken, ui: { ...discovery.ui, baseUrl: loopback(config.forwarding.ui.hostPort) }, workspace: matches[0] };
      connection.focus = normalFocus ? { kind: "normal-ui-control", instanceID: config.cloud.instanceID, profile: config.guest.profile,
        workspace: config.guest.workspace, uiBaseURL: connection.ui.baseUrl, serverBaseURL: base,
        guestUiBaseURL: discovery.ui.baseUrl, guestServerBaseURL: loopback(port), discoverySha256: sha256(await readFile(output)) }
        : { ...discovery.focus, baseUrl: loopback(config.forwarding.focus.hostPort) };
      if (normalFocus) normalUiFocusBinding(connection);
      await privateWrite(join(operations,`focus-binding-${randomUUID()}.json`), { focus: connection.focus.kind ? connection.focus : { kind: "legacy-focus-hook" }, discoveryPath: output, nativeSettingsOverride: false });
      return connection;
    },
    async toolExecutions({ownedSessionIDs}) {
      const observer=config.traceObserver;
      if(!observer?.directory || !observer.pluginPath || !observer.bundleSha256)throw new Error("Reviewed fixed observer paths/code identity are mandatory before model admission");
      const output=join(operations,`tool-journals-${randomUUID()}.json`);
      if(observer.transport==="linux-peercred-write-only") {
        if(!observer.producerDirectory || !observer.recorderPath || !observer.recorderSha256 || !observer.enginePID || !observer.engineStartTimeTicks)throw new Error("Complete fixed write-only recorder binding is required");
        await files.python(String.raw`
import hashlib,json,os,pathlib,pwd,re,stat,sys
root,producer,plugin,plugin_sha,recorder,recorder_sha,pid,start=sys.argv[1:]
root=pathlib.Path(root);producer=pathlib.Path(producer);plugin=pathlib.Path(plugin);recorder=pathlib.Path(recorder)
if not str(root).startswith('/var/lib/legalwork-benchmark-recorder/') or not root.is_dir() or str(root.resolve())!=str(root) or root.stat().st_uid!=0 or stat.S_IMODE(root.stat().st_mode)&0o077:raise RuntimeError('Fixed root-private recorder directory unavailable')
for path,expected in [(plugin,plugin_sha),(recorder,recorder_sha)]:
 if path.is_symlink() or path.stat().st_uid!=0 or path.stat().st_mode&0o022 or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise RuntimeError('Recorder/observer code differs from reviewed source')
if not str(producer).startswith('/home/legalwork/') or str(producer.resolve())!=str(producer) or not producer.is_dir():raise RuntimeError('Fixed producer metadata directory unavailable')
collector_path=root/'health.json'
if collector_path.is_symlink() or collector_path.stat().st_uid!=0 or stat.S_IMODE(collector_path.stat().st_mode)&0o077:raise RuntimeError('Collector health is not private')
collector=json.loads(collector_path.read_text());binding=collector['binding'];actual=pathlib.Path('/proc')/str(pid)
fields=(actual/'stat').read_text().rsplit(')',1)[1].split()
if binding['pid']!=int(pid) or str(binding['startTimeTicks'])!=start or fields[19]!=start or os.path.realpath(actual/'exe')!=binding['executable']:raise RuntimeError('Exact live native engine binding changed')
items=[]
for path in sorted(producer.iterdir()):
 if not re.fullmatch(r'producer\.[a-f0-9-]{36}\.json',path.name):continue
 if path.is_symlink() or not path.is_file() or path.stat().st_uid!=pwd.getpwnam('legalwork').pw_uid:raise RuntimeError('Unsafe producer metadata file')
 health=json.loads(path.read_text());identifier=health['observerInstance'];entry=collector['observers'].get(identifier)
 if path.name!=health['healthName'] or not entry:raise RuntimeError('Producer registration unavailable')
 name=entry['eventsName']
 if not re.fullmatch(r'events\.[a-f0-9-]{36}\.jsonl',name):raise RuntimeError('Unsafe fixed root journal name')
 journal=root/name;registration=root/('registration.'+identifier+'.json')
 for private in [journal,registration]:
  if private.is_symlink() or not private.is_file() or private.stat().st_uid!=0 or stat.S_IMODE(private.stat().st_mode)&0o077:raise RuntimeError('Raw trace/registration is not root-private')
 registered=json.loads(registration.read_text())
 if registered['recordSha256']!=health['registrationSha256'] or registered['payload']['observerInstance']!=identifier or registered['payload']['location']!=health['location']:raise RuntimeError('Observer registration identity changed')
 raw=journal.read_bytes();items.append({'health':health,'raw':raw.decode(),'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'registration':registered})
if not items:raise RuntimeError('No actual engine-peer registered observer')
print(json.dumps({'journals':items,'collectorHealth':collector,'observedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'observerBundleSha256':plugin_sha,'transport':'root-only-fixed-ssh-relay'}))
`,[observer.directory,observer.producerDirectory,observer.pluginPath,observer.bundleSha256,observer.recorderPath,observer.recorderSha256,String(observer.enginePID),String(observer.engineStartTimeTicks)],{output});
      } else {
      await files.python(String.raw`
import hashlib,json,os,pathlib,re,stat,sys
root=pathlib.Path(sys.argv[1]);plugin=pathlib.Path(sys.argv[2]);expected=sys.argv[3]
if root.is_symlink() or plugin.is_symlink() or plugin.stat().st_uid!=0 or plugin.stat().st_mode&0o022:raise RuntimeError('Observer code path/ownership is not the reviewed private instrumentation')
if hashlib.sha256(plugin.read_bytes()).hexdigest()!=expected:raise RuntimeError('Observer code differs from reviewed receipt')
if not str(root).startswith('/home/legalwork/') or not root.is_dir():raise RuntimeError('Fixed isolated observer directory unavailable')
items=[]
for path in sorted(root.iterdir()):
 if not re.fullmatch(r'health\.[a-f0-9-]{36}\.json',path.name):continue
 if path.is_symlink() or not path.is_file():raise RuntimeError('Unsafe observer health file')
 health=json.loads(path.read_text());name=health['eventsName']
 if not re.fullmatch(r'events\.[a-f0-9-]{36}\.jsonl',name):raise RuntimeError('Unsafe journal name')
 journal=root/name
 if journal.is_symlink() or not journal.is_file():raise RuntimeError('Unsafe observer journal file')
 raw=journal.read_bytes();items.append({'health':health,'raw':raw.decode(),'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)})
if not items:raise RuntimeError('No activated observer journal; zero rows is not activation evidence')
print(json.dumps({'journals':items,'observedAt':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'observerBundleSha256':expected}))
`,[observer.directory,observer.pluginPath,observer.bundleSha256],{output});
      }
      const captured=await readJson(output);
      const journals=captured.journals.map(item=>{
        if(observer.transport==="linux-peercred-write-only")verifyObserverRegistration(item.registration,item.health);
        const acknowledgments=observer.transport==="linux-peercred-write-only" ? verifyWriteOnlyAcknowledgments(item.health,captured.collectorHealth) : undefined;
        return {...verifyToolJournal(item.raw,item.health),health:item.health,sha256:item.sha256,bytes:item.bytes,acknowledgments};
      });
      if(journals.some(item=>item.health.location!==config.guest.workspace))throw new Error("Observer location does not match exact owned workspace");
      return {...scopeToolJournals(journals,ownedSessionIDs),journals,rawReceiptPath:output,observedAt:captured.observedAt,observerBundleSha256:captured.observerBundleSha256};
    },
    async installSkillFixture(payloadPath) {
      if(normalFocus)throw new Error("Normal packages have no benchmark installation hook. Install the exact reviewed fixture into this private shared library before boot, then verify skillInstallations and the native catalog; no user library is modified.");
      const connection=await this.discover();
      const payloadBytes=await readFile(payloadPath);
      const payload=JSON.parse(payloadBytes);
      const args=payload.args;
      const response=await fetch(`${connection.focus.baseUrl}/install-skill-files`,{method:"POST",headers:{authorization:`Bearer ${connection.focus.token}`,"content-type":"application/json"},body:JSON.stringify({args})});
      const result=await response.json();
      await privateWrite(join(operations,`skill-install-${randomUUID()}.json`),{payloadSha256:sha256(payloadBytes),responseStatus:response.status,result,method:"ordinary-desktop-installSkillFiles-ipc",inferenceCalls:0});
      if(!response.ok || result.result?.ok!==true)throw new Error("Exact isolated skill installation failed; no inference was attempted");
      return this.skillInstallations();
    },
    async skillInstallations() {
      if(!config.skillInstallations?.length) return {fixtures:[],selectedDefinitions:[]};
      const output=join(operations,`skill-bytes-${randomUUID()}.json`);
      if(!config.selectedSkillsReceiptPath || !config.selectedSkillsReceiptSha256 || !Number.isInteger(config.selectedSkillCount) || config.selectedSkillCount<1)throw new Error("Fixture installation requires the pinned nonempty original selected-library receipt");
      const selectedReceiptBytes=await readFile(config.selectedSkillsReceiptPath);
      if(sha256(selectedReceiptBytes)!==config.selectedSkillsReceiptSha256)throw new Error("Original selected-library receipt differs from its reviewed identity");
      const selected=JSON.parse(selectedReceiptBytes).selectedDefinitions;
      if(!Array.isArray(selected) || selected.length!==config.selectedSkillCount || new Set(selected.map(item=>item.destination)).size!==selected.length || selected.some(item=>!item.name || !item.destination || !item.sourceSha256))throw new Error("Original selected-library inventory is incomplete or duplicated");
      await files.python(String.raw`
import datetime,hashlib,json,os,pathlib,pwd,sys
fixtures=json.loads(sys.argv[1]);selected=json.loads(sys.argv[2]);user=pwd.getpwnam('legalwork');receipts=[]
for fixture in fixtures:
 root=pathlib.Path(fixture['directory'])
 if not str(root).startswith('/home/legalwork/') or root.is_symlink():raise RuntimeError('Fixture root is not the ordinary isolated global skill installation')
 entries=[]
 expectedFiles={entry['path']:entry for entry in fixture['files']}
 allowedDirs={str(pathlib.PurePosixPath(name).parent) for name in expectedFiles}
 for path in sorted(root.rglob('*')):
  name=path.relative_to(root).as_posix()
  if path.is_symlink():raise RuntimeError('Unexpected installed source link')
  if path.is_dir():
   if name not in allowedDirs:raise RuntimeError('Unexpected installed source directory')
   continue
  if not path.is_file() or name not in expectedFiles or path.stat().st_uid!=user.pw_uid:raise RuntimeError('Unexpected installed source or ownership')
  data=path.read_bytes();actual={'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
  if actual!=expectedFiles[name]:raise RuntimeError('Installed source bytes changed')
  entries.append(actual)
 if len(entries)!=len(expectedFiles):raise RuntimeError('Installed fixture source inventory is incomplete')
 receipts.append({'name':fixture['name'],'scope':'global','directory':str(root),'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'actual-installed-file-bytes','files':entries})
for item in selected:
 path=pathlib.Path(item['destination'])
 if hashlib.sha256(path.read_bytes()).hexdigest()!=item['sourceSha256']:raise RuntimeError('An original selected skill definition changed or disappeared')
print(json.dumps({'fixtures':receipts,'selectedDefinitions':[{'name':x['name'],'path':x['destination'],'sha256':x['sourceSha256']} for x in selected],'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}))
`,[JSON.stringify(config.skillInstallations),JSON.stringify(selected)],{output});
      return readJson(output);
    },
    async identity({ evidence, expectedBase, controllerGit }) {
      await verifyTunnel();
      const output = join(operations, `runtime-${randomUUID()}.json`);
      const localManifestBytes = await readFile(config.runtimeManifestPath);
      const nativeContract = config.nativePackage ? nativePackageIdentityContract(JSON.parse(localManifestBytes),
        await readFile(config.nativePackage.packageReceiptPath), { ...config.nativePackage, runtimeRoot: config.guest.runtime }) : null;
      await files.python(physicalRendererVerificationPython + String.raw`
import hashlib,json,os,pathlib,pwd,stat,sys
root=pathlib.Path(sys.argv[1]);native=json.loads(sys.argv[3]);path=pathlib.Path(sys.argv[2]) if native else root/'benchmark-runtime-manifest.json'
manifest=path.read_bytes();data=json.loads(manifest)
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  while True:
   b=f.read(1024*1024)
   if not b:break
   h.update(b)
 return h.hexdigest()
engine=root/native['engineRelativePath'] if native else root/'resources/sidecars/opencode'
for p in [root,path,root/'resources/app.asar',engine]:
 s=p.lstat()
 if stat.S_ISLNK(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise RuntimeError('Published runtime/receipt is linked or writable outside root')
actual_asar_sha=digest(root/'resources/app.asar')
if actual_asar_sha!=data['build']['asar']['sha256'] or digest(engine)!=data['runtime']['engineBinarySha256']:raise RuntimeError('Actual executable/ASAR differs from build receipt')
physical_renderer=None
if native:
 receipt=pathlib.Path(native['packageReceiptGuestPath']);s=receipt.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022 or s.st_nlink!=1 or digest(receipt)!=native['packageReceiptSha256']:raise RuntimeError('Original sealed native package receipt differs')
 directory=root/native['engineDirectory'];expected={pathlib.PurePosixPath(e['path']).name:e for e in native['files']}
 if {p.name for p in directory.iterdir()}!=set(expected):raise RuntimeError('Native five-file directory has missing or extra members')
 for p in [directory,*directory.parents]:
  if p==root.parent:break
  s=p.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:raise RuntimeError('Native engine ancestor is linked or writable')
 for name,e in expected.items():
  p=directory/name;s=p.lstat()
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_gid!=0 or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=int(e['mode'],8) or s.st_size!=e['size'] or digest(p)!=e['sha256']:raise RuntimeError('Native engine member bytes/identity differ: '+name)
 provenance=json.loads((directory/'provenance.json').read_text())
 if provenance['version']!=native['engineVersion'] or provenance['target']!='linux-x64-baseline' or provenance['binary']['sha256']!=native['engineSha256']:raise RuntimeError('Native provenance/version/target/binary differs')
 physical_renderer=verify_physical_renderer(root,data,json.loads(receipt.read_text()),actual_asar_sha)
user=pwd.getpwnam('legalwork');processes=[]
for item in pathlib.Path('/proc').iterdir():
 if not item.name.isdigit():continue
 try:
  exe=pathlib.Path(os.readlink(item/'exe'))
  if item.stat().st_uid==user.pw_uid and exe.name.startswith('opencode'):
   if (native and exe!=engine) or (not native and not str(exe).startswith(str(root/'resources/sidecars')+'/')) or str(exe).endswith(' (deleted)'):raise RuntimeError('Unexpected additional app-UID OpenCode executable outside the reviewed bundle')
   processes.append({'pid':int(item.name),'uid':user.pw_uid,'executable':str(exe),'sha256':digest(item/'exe')})
 except (FileNotFoundError,PermissionError,ProcessLookupError):pass
if len(processes)!=1 or processes[0]['sha256']!=data['runtime']['engineBinarySha256']:raise RuntimeError('Exactly one matching actual app-owned engine is required')
print(json.dumps({'manifest':data,'manifestSha256':hashlib.sha256(manifest).hexdigest(),'processes':processes,'appUID':user.pw_uid,'appGroups':os.getgrouplist(user.pw_name,user.pw_gid),'nativePackageVerified':native,'physicalRendererVerified':physical_renderer}))
`, [config.guest.runtime,config.nativePackage?.manifestGuestPath ?? '',JSON.stringify(nativeContract)], { output });
      const observed = await readJson(output);
      const manifestBytes = await readFile(config.runtimeManifestPath);
      if (sha256(manifestBytes) !== observed.manifestSha256) throw new Error("Guest runtime manifest differs from independent controller build receipt");
      if (observed.manifest.source.commit !== expectedBase || observed.manifest.source.archiveSha256 !== config.sourceArchiveSha256) throw new Error("Guest source/build inputs differ from the reviewed arm");
      const cloudOutput = join(operations, `cloud-${randomUUID()}.json`);
      const { privateProcess } = await import("./remote-files.mjs");
      await privateProcess("gcloud", ["compute", "instances", "describe", config.cloud.instance, `--project=${config.cloud.project}`, `--zone=${config.cloud.zone}`, "--format=json(id,status,scheduling,disks,serviceAccounts,networkInterfaces,machineType)"] , { evidence: join(operations, `cloud-${randomUUID()}`), output: cloudOutput });
      const cloud = await readJson(cloudOutput);
      if (cloud.id !== config.cloud.instanceID || cloud.status !== "RUNNING" || cloud.serviceAccounts?.length || cloud.scheduling?.instanceTerminationAction !== "DELETE" || Date.parse(cloud.scheduling?.terminationTime) !== Date.parse(config.cloud.terminationTime)
        || cloud.disks.some(disk => disk.autoDelete !== true)) throw new Error("Actual cloud ownership, deletion lease or credential isolation differs from approved plan");
      if (cloud.machineType?.split("/").at(-1) !== config.machine) throw new Error("Actual guest machine differs from reviewed comparison environment");
      const boot = cloud.disks.filter(disk => disk.boot);
      if (boot.length !== 1 || !boot[0].source.startsWith(`https://www.googleapis.com/compute/v1/projects/${config.cloud.project}/zones/${config.cloud.zone}/disks/`)) throw new Error("Unknown actual guest boot disk identity");
      const diskOutput = join(operations, `disk-${randomUUID()}.json`);
      await privateProcess("gcloud", ["compute", "disks", "describe", boot[0].source.split("/").at(-1), `--project=${config.cloud.project}`, `--zone=${config.cloud.zone}`, "--format=json(id,name,sourceImage,sourceImageId,sizeGb,type)"] , { evidence: join(operations, `disk-${randomUUID()}`), output: diskOutput });
      const disk = await readJson(diskOutput);
      if (disk.sourceImageId !== config.image.id || disk.sourceImage?.split("/").at(-1) !== config.image.name || disk.sizeGb !== "100" || disk.type?.split("/").at(-1) !== "pd-standard") throw new Error("Actual boot image/storage differs from reviewed plan");
      const isolationBytes = await readFile(config.isolationReceiptPath);
      const isolation = JSON.parse(isolationBytes);
      if (isolation.instanceID !== config.cloud.instanceID || isolation.runtimeManifestSha256 !== observed.manifestSha256
        || isolation.profile !== config.guest.profile || isolation.workspace !== config.guest.workspace) throw new Error("Isolation receipt belongs to a different guest/runtime/profile/workspace");
      actualIdentity = { git: { head: observed.manifest.source.commit, originDev: expectedBase, branch: config.sourceBranch, sourceInputKind: observed.manifest.source.kind, archiveSha256: observed.manifest.source.archiveSha256 }, runtime: { ...observed.manifest.runtime, ...(observed.physicalRendererVerified ? { renderer: { ...observed.manifest.runtime.renderer, physicalVerification: observed.physicalRendererVerified } } : {}), transport: "scoped-ssh-forwarded-guest-loopback", actualEngineProcesses: observed.processes, appUID: observed.appUID, appGroups: observed.appGroups }, constants: observed.manifest.constants, build: observed.manifest.build, runtimeManifestSha256: observed.manifestSha256, cloud: { instanceID: cloud.id, instance: config.cloud.instance, terminationTime: cloud.scheduling.terminationTime, image: { id: disk.sourceImageId, name: disk.sourceImage.split("/").at(-1), source: disk.sourceImage }, machine: cloud.machineType.split("/").at(-1), bootDisk: disk }, isolation: { state: isolation.state, receiptSha256: sha256(isolationBytes), profile: config.guest.profile, workspace: config.guest.workspace }, controller: { node: process.version, platform: process.platform, arch: process.arch, source: controllerGit } };
      await privateWrite(join(evidence, "packaged-runtime-observation.json"), { observed, cloud, disk, isolation });
      return actualIdentity;
    },
    async assertModelAdmission(record, { suite, taskID } = {}) {
      await verifyTunnel();
      if (!actualIdentity || record.runtimeManifestSha256 !== actualIdentity.runtimeManifestSha256) throw new Error("Current actual guest identity is required before model admission");
      const approval = await readJson(config.admissionReceiptPath);
      if (!config.admissionSuitePath) throw new Error("A fixed controller-owned reviewed suite path is required before paid admission");
      verifySuiteAdmission({ approval, suiteBytes: await readFile(config.admissionSuitePath), suite, taskID });
      verifyAdmission({ approval, isolationBytes: await readFile(config.isolationReceiptPath), identity: actualIdentity, instanceID: config.cloud.instanceID });
      await this.providerCapture(await readJson(join(config.controllerRoot, "capture-connection.json")));
      return true;
    },
  };
}
