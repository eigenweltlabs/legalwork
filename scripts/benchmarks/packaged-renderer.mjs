// Controller-only identity checks for the normal package's physical renderer.
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function verifyPackagedRendererIdentity(identity) {
  const renderer = identity.runtime?.renderer;
  if (renderer?.kind === "packaged-linux-asar") return true;
  const proof = renderer?.physicalVerification;
  if (renderer?.kind !== "packaged-linux-renderer-and-asar"
    || renderer.physicalDirectory !== "resources/app-dist"
    || !Number.isSafeInteger(renderer.files) || renderer.files <= 0
    || !digest(renderer.asarSha256) || renderer.asarSha256 !== identity.build?.asar?.sha256
    || !digest(renderer.treeSha256) || renderer.treeSha256 !== identity.build?.appTreeSha256
    || proof?.method !== "actual-complete-sealed-physical-renderer"
    || proof.asarRelativePath !== "resources/app.asar" || proof.asarSha256 !== renderer.asarSha256
    || proof.physicalDirectory !== renderer.physicalDirectory || proof.entries !== renderer.files
    || proof.treeSha256 !== renderer.treeSha256)
    throw new Error("Actual packaged renderer/ASAR identity is incomplete or differs from the reviewed sealed tree");
  return true;
}

export const physicalRendererVerificationPython = String.raw`
def verify_physical_renderer(root, data, receipt, actual_asar_sha, owner_uid=0, owner_gid=0):
 import hashlib,json,pathlib,stat
 renderer=data['runtime']['renderer']
 if renderer.get('kind')!='packaged-linux-renderer-and-asar':return None
 relative=renderer.get('physicalDirectory')
 if relative!='resources/app-dist':raise RuntimeError('Unexpected physical renderer path')
 directory=root/relative
 for p in [directory,*directory.parents]:
  if p==root.parent:break
  s=p.lstat()
  if not stat.S_ISDIR(s.st_mode) or s.st_uid!=owner_uid or s.st_gid!=owner_gid or s.st_mode&0o022:raise RuntimeError('Physical renderer ancestor is linked or writable')
 expected=[e for e in receipt['files'] if e['path'].startswith(relative+'/')]
 if not expected or len({e['path'] for e in expected})!=len(expected):raise RuntimeError('Physical renderer receipt is empty or duplicated')
 if any(pathlib.PurePosixPath(e['path']).is_absolute() or '..'in pathlib.PurePosixPath(e['path']).parts for e in expected):raise RuntimeError('Invalid physical renderer member')
 actual={p.relative_to(root).as_posix():p for p in directory.rglob('*')}
 if set(actual)!={e['path']for e in expected}:raise RuntimeError('Physical renderer has missing or extra members')
 for e in expected:
  p=actual[e['path']];s=p.lstat()
  kind='file'if stat.S_ISREG(s.st_mode)else'directory'if stat.S_ISDIR(s.st_mode)else'unsupported'
  if kind!=e['type'] or kind=='unsupported' or s.st_uid!=owner_uid or s.st_gid!=owner_gid or s.st_uid!=e['uid'] or s.st_gid!=e['gid'] or stat.S_IMODE(s.st_mode)!=int(e['mode'],8) or s.st_mode&0o022 or s.st_nlink!=e['nlink'] or s.st_size!=e['size']:raise RuntimeError('Physical renderer member identity differs')
  if kind=='file':
   h=hashlib.sha256()
   with p.open('rb')as f:
    while True:
     b=f.read(1024*1024)
     if not b:break
     h.update(b)
   if h.hexdigest()!=e['sha256']:raise RuntimeError('Physical renderer bytes differ')
 tree=hashlib.sha256(json.dumps(expected,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 if type(renderer.get('files'))is not int or renderer['files']<=0 or len(expected)!=renderer['files'] or tree!=renderer.get('treeSha256') or tree!=data['build'].get('appTreeSha256') or actual_asar_sha!=renderer.get('asarSha256') or actual_asar_sha!=data['build']['asar'].get('sha256'):raise RuntimeError('Physical renderer count/tree/ASAR digest differs')
 return {'method':'actual-complete-sealed-physical-renderer','asarRelativePath':'resources/app.asar','asarSha256':actual_asar_sha,'physicalDirectory':relative,'entries':len(expected),'treeSha256':tree}
`;
