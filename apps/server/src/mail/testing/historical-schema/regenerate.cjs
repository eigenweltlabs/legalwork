const {execFileSync}=require('node:child_process');const fs=require('node:fs');const ts=require(process.cwd()+'/apps/server/node_modules/typescript');const vm=require('node:vm');
for(const [commit,from,to] of [['9cd9b7803',0,5],['8435d9a0d',5,9]]){
 let source=execFileSync('git',['show',commit+':apps/server/src/mail/storage/schema.ts'],{encoding:'utf8'});
 if(to===9){const graph=execFileSync('git',['show',commit+':apps/server/src/mail/storage/graph-state.ts'],{encoding:'utf8'}).match(/export const GRAPH_SCHEMA_SQL = (`[\s\S]*?`);/)[1];source=source.replace('import { GRAPH_SCHEMA_SQL } from "./graph-state.js";',`const GRAPH_SCHEMA_SQL=${graph};`);}
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const context={exports:{}};vm.runInNewContext(js,context);const statements=[];
 context.exports.migrateMailSchema({exec(sql){statements.push(sql.trim()+';');},get(sql){return sql==='PRAGMA foreign_keys'?{foreign_keys:1}:from?{version:from}:undefined;},transaction(fn){fn();},run(sql,values){statements.push(sql.replace('?',String(values[0]))+';');}});
 fs.writeFileSync(`apps/server/src/mail/testing/historical-schema/v${from}-to-v${to}.sql`,`-- Frozen executed migration SQL from ${commit}:apps/server/src/mail/storage/schema.ts\n-- Existing version ${from}; target version ${to}. No current schema imports.\n`+statements.join('\n')+'\n');
}
