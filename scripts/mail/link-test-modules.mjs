import {mkdir,readdir,realpath,symlink} from 'node:fs/promises';
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
