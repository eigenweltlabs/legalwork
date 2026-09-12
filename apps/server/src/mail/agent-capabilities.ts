import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,realpath,lstat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {enforceMailWindowsAcl} from './storage/windows-acl.js';
const entry=z.object({id:z.string().uuid(),token:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const file=z.object({directory:z.string(),grants:z.array(entry).max(100)}).strict();
export const capabilityFileName=(directory:string)=>createHash('sha256').update(directory).digest('hex')+'.json';
const changes=new Map<string,Promise<void>>();
/** Serialize updates to one private engine file. Preserve every active capability. */
export async function provisionMailCapability(root:string,directory:string,value:z.infer<typeof entry>|null,activeIds?:()=>Promise<string[]>){
 const canonical=await realpath(directory),path=join(root,capabilityFileName(canonical));
 const update=(changes.get(path)??Promise.resolve()).catch(()=>{}).then(async()=>{
  await mkdir(root,{recursive:true,mode:0o700});await enforceMailWindowsAcl(root,true);
  const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.mode&0o077))throw new Error('Private capability directory required');
  let grants:z.infer<typeof entry>[]=[];
  try{const stored=file.parse(JSON.parse(await readFile(path,'utf8')));if(stored.directory!==canonical)throw new Error('Capability directory mismatch');grants=stored.grants;}catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;}
  const active=await activeIds?.();
  grants=grants.filter(item=>(!active||active.includes(item.id))&&item.id!==value?.id);if(value&&(!active||active.includes(value.id)))grants.push(value);if(grants.length>100)throw new Error('Capability budget exceeded');
  const temporary=path+'.'+randomUUID()+'.new';try{await writeFile(temporary,JSON.stringify({directory:canonical,grants}),{mode:0o600,flag:'wx'});await enforceMailWindowsAcl(temporary,false);await rename(temporary,path);}finally{await rm(temporary,{force:true});}
 });
 changes.set(path,update);try{await update;}finally{if(changes.get(path)===update)changes.delete(path);}
}
