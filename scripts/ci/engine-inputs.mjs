// Package metadata and patches are inputs to their owning consumers. A new
// export or a package license is not a change to every existing engine API.
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

const runtimeFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const entryFields = ['type', 'main', 'module', 'imports'];
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const matches = (pattern,value) => {
  if(!pattern.includes('*'))return pattern===value;
  const [prefix,suffix]=pattern.split('*');
  return value.startsWith(prefix)&&value.endsWith(suffix);
};
function read(root,ref,file) {
  if (!ref) return existsSync(path.join(root,file)) ? readFileSync(path.join(root,file),'utf8') : undefined;
  const result = execFileSync('git',['ls-tree','--name-only',ref,'--',file],{cwd:root,encoding:'utf8'});
  return result.trim() ? execFileSync('git',['show',`${ref}:${file}`],{cwd:root,encoding:'utf8'}) : undefined;
}
function exportsOf(pkg) {
  if (!pkg.exports) return {'.':pkg.main ?? pkg.module};
  return typeof pkg.exports === 'string' || !Object.keys(pkg.exports).some(key=>key.startsWith('.'))
    ? {'.':pkg.exports} : pkg.exports;
}
function consumers(graphs, name) {
  return [...new Set(graphs.flatMap(graph=>[...graph.imports].filter(([specifier])=>specifier===name||specifier.startsWith(name+'/')).flatMap(([,files])=>[...files])))];
}
export function engineMetadataInputs(files, {root,ref,base,graphs}) {
  let unknown = false;
  const inputs = new Set(), manifests = new Map();
  const paths = execFileSync('git',ref ? ['ls-tree','-r','--name-only',ref,'--','apps/','packages/']
    : ['ls-files','--cached','--others','--exclude-standard','--','apps/','packages/'],{cwd:root,encoding:'utf8'}).split('\n')
    .filter(file=>/^(?:apps|packages)\/[^/]+\/package\.json$/.test(file));
  for (const file of paths) {
    const text = read(root,ref,file);
    if (text) manifests.set(file, JSON.parse(text));
  }
  const serverRuntime = new Set();
  const visit = file => {
    const pkg=manifests.get(file);
    if (!pkg) return;
    for (const name of runtimeFields.flatMap(field=>Object.keys(pkg[field]??{}))) {
      if(serverRuntime.has(name))continue;
      serverRuntime.add(name);
      for(const [other,value] of manifests)if(value.name===name)visit(other);
    }
  };
  visit('apps/server/package.json');
  for (const file of files) {
    if (file.startsWith('patches/')) {
      const match = /^patches\/(.+)@[^@/]+\.patch$/.exec(file);
      if (!match) { unknown = true; continue; }
      const name=match[1].replace('__','/');
      const owners=[...manifests.values()].filter(pkg=>runtimeFields.concat('devDependencies').some(field=>name in (pkg[field]??{})));
      if(!owners.length) { unknown = true; continue; }
      if(serverRuntime.has(name)) {
        const used=consumers(graphs,name);
        if(!used.length)unknown=true;
        for(const input of used)inputs.add(input);
      }
      continue;
    }
    if (!file.endsWith('/package.json')) continue;
    const currentText=read(root,ref,file), oldText=base ? read(root,base,file) : undefined;
    if(!currentText || !oldText) { unknown = true; continue; }
    const current=JSON.parse(currentText), previous=JSON.parse(oldText);
    const name=current.name??previous.name;
    if (entryFields.some(field=>!equal(current[field],previous[field]))) {
      if(file==='apps/server/package.json')unknown=true;
      else for(const input of consumers(graphs,name))inputs.add(input);
    }
    const oldExports=exportsOf(previous), newExports=exportsOf(current);
    for(const key of new Set([...Object.keys(oldExports),...Object.keys(newExports)])) {
      if(equal(oldExports[key],newExports[key]))continue;
      // New importers and source files are selected through their own subjects.
      // A new export cannot change resolution for existing unrelated imports.
      if(!(key in oldExports)&&!Object.keys(oldExports).some(pattern=>matches(pattern,key)))continue;
      if(file==='apps/server/package.json') { unknown=true; continue; }
      const specifier=key==='.'?name:name+key.slice(1);
      for(const graph of graphs)for(const [imported,consumers] of graph.imports) {
        if(matches(specifier,imported))for(const input of consumers)inputs.add(input);
      }
    }
    const dependencyChanged=runtimeFields.some(field=>!equal(current[field],previous[field]));
    if(dependencyChanged) {
      if(file==='apps/server/package.json')unknown=true;
      else for(const input of consumers(graphs,name))inputs.add(input);
    }
  }
  return {inputs:[...inputs],unknown};
}
