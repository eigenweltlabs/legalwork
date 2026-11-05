// Controller-only POSIX collector. Reads the exact service-returned file as the
// ordinary app UID, with directory/file descriptors that never follow links.
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { privateWrite } from "./private-write.mjs";
import { shellQuote } from "./remote-files.mjs";
import { browserDownloadKey } from "./browser-register-evidence.mjs";

export const browserDownloadReadPython = String.raw`
import base64,hashlib,json,os,pathlib,stat,sys
request=json.loads(sys.argv[1]);path=request['path'];uid=request['uid']
if uid<=0 or os.getuid()!=uid or os.geteuid()!=uid:raise RuntimeError('Reader is not the approved ordinary app UID')
if not os.path.isabs(path) or os.path.normpath(path)!=path:raise RuntimeError('Download path must be absolute and normalized')
downloads=request['workspaceDownloads'];temporary=request['nativeTempRoot']
for root in (downloads,temporary):
 if not os.path.isabs(root) or os.path.normpath(root)!=root:raise RuntimeError('Untrusted download scope root')
scope=None
if path!=downloads and os.path.commonpath([path,downloads])==downloads:scope='workspace-downloads'
elif path!=temporary and os.path.commonpath([path,temporary])==temporary:
 parts=pathlib.PurePosixPath(path).relative_to(temporary).parts
 if len(parts)==3 and parts[0].startswith('opencode-browser-') and len(parts[0])>len('opencode-browser-') and parts[1].isdigit():scope='native-browser-temp'
if scope is None:raise RuntimeError('Returned path is outside approved project/native download scopes')
descriptors=[]
try:
 directory=os.open('/',os.O_RDONLY|os.O_DIRECTORY);descriptors.append(directory)
 for component in pathlib.PurePosixPath(path).parts[1:-1]:
  directory=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory);descriptors.append(directory)
 filename=pathlib.PurePosixPath(path).name
 previous=os.stat(filename,dir_fd=directory,follow_symlinks=False)
 if not stat.S_ISREG(previous.st_mode) or previous.st_uid!=uid or previous.st_nlink!=1:raise RuntimeError('Expected one ordinary app-owned regular download')
 fd=os.open(filename,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory);descriptors.append(fd)
 before=os.fstat(fd)
 if not stat.S_ISREG(before.st_mode) or before.st_uid!=uid or before.st_nlink!=1 or (before.st_dev,before.st_ino)!=(previous.st_dev,previous.st_ino):raise RuntimeError('Download identity changed before open')
 chunks=[];digest=hashlib.sha256();size=0
 while True:
  chunk=os.read(fd,1024*1024)
  if not chunk:break
  chunks.append(chunk);digest.update(chunk);size+=len(chunk)
 after=os.fstat(fd)
 identity=lambda s:(s.st_dev,s.st_ino,s.st_uid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
 if identity(before)!=identity(after) or size!=before.st_size:raise RuntimeError('Download changed during collection')
 print(json.dumps({'sourcePath':path,'acquisition':{'uid':os.getuid(),'expectedUID':uid,'regularFile':True,'noSymlinks':True,'scope':scope,'device':before.st_dev,'inode':before.st_ino,'bytes':size,'sha256':digest.hexdigest(),'mtimeNs':before.st_mtime_ns,'ctimeNs':before.st_ctime_ns},'contentBase64':base64.b64encode(b''.join(chunks)).decode('ascii')}))
finally:
 for descriptor in reversed(descriptors):os.close(descriptor)
`;

export function createSshBrowserDownloadCollector({ files, appUID, workspaceDownloads, nativeTempRoot }) {
  if (typeof files?.ssh !== "function" || !Number.isSafeInteger(appUID) || appUID <= 0
    || [workspaceDownloads, nativeTempRoot].some(path => typeof path !== "string" || !posix.isAbsolute(path) || posix.normalize(path) !== path)) throw new Error("Pin the actual app UID and exact POSIX workspace/native temp roots");
  return async ({ candidates, evidence }) => {
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const receipts = [];
    for (const candidate of candidates) {
      const key = browserDownloadKey(candidate), wirePath = join(evidence, `${key}.wire.json`);
      const request = { path: candidate.file.path, uid: appUID, workspaceDownloads, nativeTempRoot };
      await files.ssh(["sudo", "-n", "runuser", "-u", "legalwork", "--", "python3", "-c", browserDownloadReadPython, JSON.stringify(request)].map(shellQuote).join(" "), { output: wirePath });
      const result = JSON.parse(await readFile(wirePath, "utf8")), bytes = Buffer.from(result.contentBase64, "base64");
      if (result.sourcePath !== candidate.file.path || result.acquisition?.uid !== appUID || result.acquisition?.expectedUID !== appUID
        || result.acquisition.bytes !== bytes.length || bytes.toString("base64") !== result.contentBase64
        || createHash("sha256").update(bytes).digest("hex") !== result.acquisition.sha256) throw new Error("Actual download collection bytes or identity changed in transit");
      const collectedFile = join(evidence, `${key}.download`); await privateWrite(collectedFile, bytes);
      const receipt = { ...result, key, method: "actual-app-uid-no-follow-file-bytes", collectedFile, wirePath };
      await privateWrite(join(evidence, `${key}.receipt.json`), receipt); receipts.push(receipt);
    }
    return receipts;
  };
}
