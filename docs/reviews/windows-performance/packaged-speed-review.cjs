// Run in Windows against unpacked, unmodified CI applications.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn, spawnSync} = require('node:child_process');
const {setTimeout: sleep} = require('node:timers/promises');
const root = path.resolve(process.argv[2] || path.join(os.homedir(), 'legalwork-speed-review'));
const output = process.argv[4] ? path.resolve(process.argv[4]) : path.join(root, `samples-${Date.now()}`);
const warm = Boolean(process.argv[4]);
const runs = Number(process.argv[3] || 3);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const round = value => Math.round(value * 10) / 10;
async function until(fn, milliseconds = 90000) {
  const end = Date.now() + milliseconds;
  let error;
  while (Date.now() < end) {
    try { const value = await fn(); if(value) return value; } catch(e) { error = e; }
    await sleep(100);
  }
  throw error || Error('Readiness timed out');
}
async function trial(arch, index) {
  const run = path.join(output, `${warm ? 0 : index}-${arch}`);
  const profile = path.join(run, 'profile'), runtime = path.join(run, 'runtime'), project = path.join(run, 'project');
  for (const directory of [profile, runtime, project]) await fs.mkdir(directory, {recursive:true});
  // Deterministic, shuffled numeric names exercise natural sorting and metadata.
  if (!warm) for(let start=0;start<2000;start+=50) await Promise.all(Array.from({length:50},(_,i)=>fs.writeFile(path.join(project, `Matter ${(start+i)*7919%2000}.txt`),'Synthetic performance fixture.\n')));
  const workspace={id:'ws_speed',name:'Speed review fixture',path:project,workspaceType:'local',preset:'starter'};
  if (!warm) {
    await fs.writeFile(path.join(profile,'legalwork-workspaces.json'),JSON.stringify({selectedId:workspace.id,activeId:workspace.id,watchedId:workspace.id,workspaces:[workspace]}));
    await fs.writeFile(path.join(runtime,'server.json'),JSON.stringify({workspaces:[workspace],authorizedRoots:[project]}));
  }
  const env={...process.env,NODE_OPTIONS:'',ELECTRON_RUN_AS_NODE:'',LEGALWORK_DEV_MODE:'0',
    LEGALWORK_ELECTRON_USERDATA:profile,LEGALWORK_ELECTRON_APP_NAME:'LegalWork Speed Review',
    LEGALWORK_ELECTRON_APP_IDENTIFIER:`com.eigenweltlabs.speed-review.${arch}`,
    LEGALWORK_DATA_DIR:runtime,LEGALWORK_SERVER_CONFIG:path.join(runtime,'server.json'),
    LEGALWORK_RUNTIME_DB:path.join(runtime,'runtime.db'),OPENCODE_DB:path.join(runtime,'opencode.db'),
    LEGALWORK_WORD_ADDIN:'0',APPDATA:path.join(run,'appdata'),LOCALAPPDATA:path.join(run,'localappdata'),
    XDG_CONFIG_HOME:path.join(run,'config'),XDG_DATA_HOME:path.join(run,'data'),XDG_CACHE_HOME:path.join(run,'cache'),XDG_STATE_HOME:path.join(run,'state'),
    OPENCODE_CONFIG_DIR:path.join(run,'config','opencode')};
  const start=performance.now();
  const child=spawn(path.join(root,arch,'LegalWork.exe'),[],{env,stdio:['ignore','pipe','pipe']});
  let log=''; child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
  let launchError;child.on('error',e=>launchError=e);
  const result={arch,index,warm,files:2000};
  try {
    const control=await until(async()=>{
      if(launchError)throw launchError;
      if(child.exitCode!==null)throw Error(`Exited ${child.exitCode}`);
      const info=await readJson(path.join(profile,'legalwork-ui-control.json'));
      const response=await fetch(`${info.baseUrl}/actions`,{headers:{authorization:`Bearer ${info.token}`},signal:AbortSignal.timeout(3000)});
      const value=await response.json();return value.ok&&value.actions.length>5?info:null;
    });
    result.rendererControlsReadyMs=round(performance.now()-start);
    const connection=await until(async()=>{
      const state=await readJson(path.join(profile,'legalwork-server-state.json'));
      const tokens=await readJson(path.join(profile,'legalwork-server-tokens.json'));
      const port=Object.values(state.workspacePorts||{})[0]||state.preferredPort;
      const token=Object.values(tokens.workspaces||{})[0]?.ownerToken;
      if (!port || !token) return null;
      const baseUrl=`http://127.0.0.1:${port}`;
      const health=await fetch(`${baseUrl}/workspaces`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)});
      await health.arrayBuffer();
      return health.ok?{baseUrl,token}:null;
    });
    result.serverReadyMs=round(performance.now()-start);
    async function request(suffix,method='GET') {
      const t=performance.now();
      const response=await fetch(`${connection.baseUrl}/workspace/ws_speed/${suffix}`,{method,headers:{authorization:`Bearer ${connection.token}`},signal:AbortSignal.timeout(120000)});
      const body=await response.text();
      if(!response.ok)throw Error(`${suffix}: ${response.status} ${body.slice(0,180)}`);
      return {ms:round(performance.now()-t),bytes:Buffer.byteLength(body)};
    }
    result.requests=[];
    for(let repeat=0;repeat<3;repeat++)for(const endpoint of ['files/list','sessions','opencode/provider','opencode/mcp'])result.requests.push({endpoint,repeat,...await request(endpoint)});
    result.reload=await request('engine/reload','POST');
    result.providerAfterReload=await request('opencode/provider');
    result.navigation=[];
    for(const panel of ['general','account','ai','extensions','appearance']) {
      const t=performance.now();
      const response=await fetch(`${control.baseUrl}/execute`,{method:'POST',headers:{authorization:`Bearer ${control.token}`,'content-type':'application/json'},body:JSON.stringify({actionId:'settings.panel.open',args:{panel}}),signal:AbortSignal.timeout(30000)});
      const value=await response.json();if(!value.ok)throw Error(value.error);
      const snapshot=await until(async()=>{
        const s=await (await fetch(`${control.baseUrl}/snapshot`,{headers:{authorization:`Bearer ${control.token}`},signal:AbortSignal.timeout(5000)})).json();
        return s.route?.endsWith(`/settings/${panel}`)?s:null;
      },20000);
      result.navigation.push({panel,ms:round(performance.now()-t),route:snapshot.route});
    }
    result.mainCpuSeconds=Number(spawnSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${child.pid}).CPU`],{encoding:'utf8'}).stdout.trim());
    return result;
  } finally {
    await fs.writeFile(path.join(run,warm?`warm-${index}-launch.log`:'launch.log'),log);
    // Only terminate the application process tree launched by this trial.
    spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
    await sleep(1000);
  }
}
(async()=>{
  await fs.mkdir(output,{recursive:true});
  const results=[];
  for(let index=0;index<runs;index++)for(const arch of index%2?['arm64','x64']:['x64','arm64']){
    try { const result=await trial(arch,index); results.push(result); console.log(JSON.stringify(result)); }
    catch(error){results.push({arch,index,error:String(error)});console.error(arch,index,String(error));}
    await fs.writeFile(path.join(output,warm?'warm-results.json':'results.json'),JSON.stringify({commit:'d24f287cf',method:'2000 synthetic files, unmodified CI packages; warm runs reuse the initialized profile. OS disk cache is not cleared. Navigation includes control-surface timing and waits for the requested route.',results},null,2));
  }
  console.log(JSON.stringify({output}));
  if(results.some(result=>result.error))process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1});
