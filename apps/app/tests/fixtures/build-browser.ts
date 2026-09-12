import {spawnSync} from 'node:child_process';
import {writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Bun's test process also runs module mocks. Keep browser resolution in a fresh process. */
export async function buildBrowserFixture(options:{entrypoints:string[];outdir:string;alias?:Record<string,string>;minify?:boolean}) {
 const builder=join(options.outdir,`build-${randomUUID()}.mjs`);
 try {
  await writeFile(builder,`const result=await Bun.build(${JSON.stringify({...options,target:'browser'})});if(!result.success)throw Error(result.logs.map(String).join('\\n'));`);
  const result=spawnSync(process.execPath,[builder],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(result.stderr||result.stdout||`Browser fixture build exited ${result.status}`);
 } finally {await rm(builder,{force:true});}
}
