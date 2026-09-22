import {mkdir,readdir,realpath,symlink,lstat,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';

// Windows resolves relative pnpm links beneath an aggregate junction from the
// temporary path. Link each resolved package instead, preserving its real parent.
export async function linkTestModules(source,destination,platform=process.platform){
  if(platform!=='win32'){await symlink(await realpath(source),destination,'dir');return;}
  await mkdir(destination,{recursive:true});
  for(const entry of await readdir(source)){
    if(entry.startsWith('.'))continue;
    if(entry.startsWith('@')){
      await mkdir(join(destination,entry),{recursive:true});
      for(const name of await readdir(join(source,entry)))await symlink(await realpath(join(source,entry,name)),join(destination,entry,name),'junction');
    }else await symlink(await realpath(join(source,entry)),join(destination,entry),'junction');
  }
}

// Remove only the fixture-owned links, never recursively traverse their targets.
// Explicit unlinking also keeps Windows junction cleanup separate from root removal.
export async function unlinkTestModules(destination){
  let stat;try{stat=await lstat(destination);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(stat.isSymbolicLink()){await unlink(destination);return;}
  for(const entry of await readdir(destination)){
    const path=join(destination,entry),entryStat=await lstat(path);
    if(entryStat.isSymbolicLink()){await unlink(path);continue;}
    if(!entry.startsWith('@')||!entryStat.isDirectory())throw new Error('Unexpected entry in test module links');
    for(const name of await readdir(path)){
      const scoped=join(path,name);if(!(await lstat(scoped)).isSymbolicLink())throw new Error('Unexpected scoped test module entry');
      await unlink(scoped);
    }
    await rmdir(path);
  }
  await rmdir(destination);
}

// Diagnose the exact owned entry on Windows instead of reporting only the root.
// lstat + unlink deliberately never follows dependency junctions or symlinks.
export async function removeTestTree(root){
  let stat;try{stat=await lstat(root);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(stat.isSymbolicLink()||!stat.isDirectory()){await unlink(root);return;}
  const errors=[];
  for(const name of await readdir(root)){
    try{await removeTestTree(join(root,name));}catch(error){errors.push(error);}
  }
  if(errors.length)throw new AggregateError(errors,`Fixture entries retained beneath ${root}`);
  await rmdir(root);
}
