// Node 24 test adapter: use the exact production ACL code, never simulated POSIX modes.
let module;
export async function mailTestWindowsAcl(path,directory){
 if(process.platform!=='win32')return;
 module??=import('../../apps/server/src/mail/storage/windows-acl.ts');
 await (await module).enforceMailWindowsAcl(path,directory);
}
