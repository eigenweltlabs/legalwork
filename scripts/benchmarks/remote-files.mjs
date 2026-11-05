// Controller-only benchmark transport. Never copy this file or a suite to an
// agent filesystem. Product remote-worker functionality is unrelated.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fingerprintTree, inside, privateWrite, readJson } from "./evidence.mjs";

export function shellQuote(value) {
  if (String(value).includes("\0")) throw new Error("NUL in controller command argument");
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export async function privateProcess(command, args, { evidence, output, input, env } = {}) {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await privateWrite(join(evidence, "command.json"), { command, args, startedAt: new Date().toISOString(), output, inputBytes: input?.length ?? 0, outputCaps: false });
  const stdout = createWriteStream(output ?? join(evidence, "stdout"), { flags: "wx", mode: 0o600 });
  const stderr = createWriteStream(join(evidence, "stderr"), { flags: "wx", mode: 0o600 });
  const child = spawn(command, args, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  if (input !== undefined) child.stdin.end(input);
  const closed = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", (code, signal) => accept({ code, signal })); });
  await Promise.all([stdout.closed ? null : once(stdout, "close"), stderr.closed ? null : once(stderr, "close")]);
  await privateWrite(join(evidence, "completion.json"), { ...closed, completedAt: new Date().toISOString() });
  if (closed.code !== 0) throw new Error(`Controller ${command} failed (${closed.code ?? closed.signal}); complete output retained privately at ${evidence}`);
}

// Tar data is untrusted agent output. Keep the original archive in full, then
// extract regular files only. Link targets are retained as metadata, never
// followed on the controller (which has access to private evidence).
const unpack = String.raw`
import hashlib,json,os,pathlib,shutil,sys,tarfile
archive,destination,receipt=sys.argv[1:]
root=pathlib.Path(destination)
if root.exists():raise RuntimeError('Refusing to merge into an existing mirror')
root.mkdir(parents=True,mode=0o700)
entries=[];seen=set()
with tarfile.open(archive,'r:*') as source:
 for member in source:
  name=member.name
  while name.startswith('./'):name=name[2:]
  if name in ('','.'):continue
  p=pathlib.PurePosixPath(name)
  if p.is_absolute() or '..' in p.parts or '\x00' in name:raise RuntimeError('Unsafe archive member')
  normalized=str(p)
  if normalized in seen:raise RuntimeError('Duplicate archive member')
  seen.add(normalized)
  target=root.joinpath(*p.parts)
  if member.isdir():target.mkdir(parents=True,exist_ok=True,mode=0o700);continue
  if member.issym() or member.islnk():
   entries.append({'path':normalized,'link':member.linkname,'type':'symlink' if member.issym() else 'hardlink','hydrated':False});continue
  if not member.isfile():
   entries.append({'path':normalized,'type':'special-file','hydrated':False});continue
  target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  digest=hashlib.sha256();size=0
  with source.extractfile(member) as incoming,open(target,'xb') as output:
   os.chmod(target,0o600)
   while True:
    block=incoming.read(1024*1024)
    if not block:break
    output.write(block);digest.update(block);size+=len(block)
  if size!=member.size:raise RuntimeError('Incomplete artifact bytes')
  entries.append({'path':normalized,'bytes':size,'sha256':digest.hexdigest(),'type':'file'})
result={'archiveBytes':os.path.getsize(archive),'entries':entries,'nonHydratedEntries':[e for e in entries if e.get('hydrated') is False],'outputCaps':False,'note':'Complete original tar retained. Controller never follows agent links or special files.'}
with open(receipt,'x') as output:os.chmod(receipt,0o600);json.dump(result,output,indent=2)
`;

export async function mirrorTaskArchive(archive, destination, evidence) {
  const receipt = join(evidence, "collection.json");
  await privateProcess("python3", ["-c", unpack, archive, destination, receipt], { evidence: join(evidence, "unpack") });
  return readJson(receipt);
}

const inspectTree = String.raw`
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);entries=[]
if not root.is_dir() or root.is_symlink():raise RuntimeError('Guest task directory is absent or a link')
for p in sorted(root.rglob('*')):
 if p.is_symlink():entries.append({'path':p.relative_to(root).as_posix(),'symlink':str(p.readlink())});continue
 if not p.is_file():continue
 digest=hashlib.sha256();size=0
 with p.open('rb') as incoming:
  while True:
   block=incoming.read(1024*1024)
   if not block:break
   digest.update(block);size+=len(block)
 entries.append({'path':p.relative_to(root).as_posix(),'bytes':size,'sha256':digest.hexdigest()})
print(json.dumps({'entries':entries}))
`;

export function compareInputEntries(local, remote) {
  const key = entries => JSON.stringify([...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(entry => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256, symlink: entry.symlink })));
  if (local.some(entry => entry.symlink) || remote.some(entry => entry.symlink) || key(local) !== key(remote)) throw new Error("The guest's complete pre-prompt input bytes differ from the controller snapshot");
  return true;
}

export function createSshFiles({ instance, project, zone, keyPath, guestWorkspace, controllerHome = "/home/lwcontroller", evidence }) {
  if (!/^[a-z0-9-]+$/.test(instance) || !/^[a-z0-9-]+$/.test(project) || !/^[a-z0-9-]+$/.test(zone)) throw new Error("Invalid test-owned cloud identity");
  if (guestWorkspace !== resolve(guestWorkspace) || controllerHome !== resolve(controllerHome)) throw new Error("Guest paths must be canonical absolute POSIX paths");
  let sequence = 0;
  const operation = name => join(evidence, `${String(++sequence).padStart(4, "0")}-${name}`);
  const flags = [`--project=${project}`, `--zone=${zone}`, "--tunnel-through-iap", `--ssh-key-file=${keyPath}`, "--quiet"];
  const ssh = (command, options = {}) => privateProcess("gcloud", ["compute", "ssh", `lwcontroller@${instance}`, ...flags, `--command=${command}`], { evidence: operation("ssh"), ...options });
  async function python(source, args, options) { await ssh(["sudo", "-n", "python3", "-c", source, ...args].map(shellQuote).join(" "), options); }
  const path = relative => inside(guestWorkspace, relative);
  return {
    guestWorkspace,
    ssh,
    python,
    async stageTask(local, relative, receiptDirectory) {
      const localManifest = await fingerprintTree(local);
      if (localManifest.entries.some(entry => entry.symlink)) throw new Error("Source-only agent input payload must not contain links");
      await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
      const archive = join(receiptDirectory, "agent-inputs.tar");
      await privateProcess("tar", ["-cf", archive, "-C", local, "."], { evidence: operation("source-tar"), env: { ...process.env, COPYFILE_DISABLE: "1" } });
      const uploaded = `${controllerHome}/source-${randomUUID()}.tar`;
      await privateProcess("gcloud", ["compute", "scp", archive, `lwcontroller@${instance}:${uploaded}`, ...flags], { evidence: operation("source-copy") });
      const target = path(relative);
      await python(String.raw`
import os,pathlib,pwd,sys,tarfile
archive,root,target=sys.argv[1:]
if os.path.realpath(root)!=root or os.path.commonpath([root,target])!=root:raise RuntimeError('Source destination escaped workspace')
path=pathlib.Path(target)
if path.exists():raise RuntimeError('Refusing to overwrite an existing guest task')
path.mkdir(parents=True,mode=0o700)
with tarfile.open(archive,'r:') as incoming:
 for member in incoming:
  p=pathlib.PurePosixPath(member.name)
  if p.is_absolute() or '..' in p.parts or not(member.isdir() or member.isfile()):raise RuntimeError('Unsafe source payload')
 incoming.extractall(path,filter='data')
user=pwd.getpwnam('legalwork')
for p in [path,*path.rglob('*')]:os.chown(p,user.pw_uid,user.pw_gid)
os.unlink(archive)
`, [uploaded, guestWorkspace, target]);
      return this.verifyTask(localManifest, relative, receiptDirectory);
    },
    async verifyTask(localManifest, relative, receiptDirectory) {
      const output = join(receiptDirectory, `guest-inputs-${randomUUID()}.json`);
      await python(inspectTree, [path(relative)], { output });
      const remote = await readJson(output);
      compareInputEntries(localManifest.entries, remote.entries);
      const receipt = { checkedAt: new Date().toISOString(), executionDirectory: path(relative), localTreeSha256: localManifest.sha256, files: remote.entries.length, fullBytesMatch: true, outputCaps: false };
      await privateWrite(join(receiptDirectory, `source-receipt-${randomUUID()}.json`), receipt);
      return receipt;
    },
    async collectTask(relative, destination, receiptDirectory) {
      await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
      const archive = join(receiptDirectory, "agent-results.tar");
      // Run tar as the actual app UID. Root may operate SSH, but must not read
      // a target that the engine itself cannot access through a crafted link.
      await ssh(["sudo", "-n", "runuser", "-u", "legalwork", "--", "tar", "-cf", "-", "-C", path(relative), "."].map(shellQuote).join(" "), { output: archive });
      return mirrorTaskArchive(archive, destination, receiptDirectory);
    },
  };
}
