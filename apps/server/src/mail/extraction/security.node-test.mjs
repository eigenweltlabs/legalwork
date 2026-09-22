import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {zipSync,strToU8} from 'fflate';
import {PDFDocument,PDFName,PDFString} from 'pdf-lib';
import {extractInProcess} from './client.js';
import {workerEnvironment} from '../runtime/executable.js';
const extract=(bytes,filename)=>extractInProcess({bytes,filename,contentType:'application/octet-stream',signal:new AbortController().signal});

test('EIG-154 Office entity and traversal fixtures cannot read or write local files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mail-extraction-security-'));
 try{
  const marker='SYNTHETIC_PRIVATE_EIG154',path=join(directory,'canary.txt');await writeFile(path,marker,{mode:0o600});
  const xml='<!DOCTYPE document [<!ENTITY steal SYSTEM "'+pathToFileURL(path).href+'">]><document><t>&steal;</t></document>';
  await assert.rejects(extract(zipSync({'word/document.xml':strToU8(xml)}),'entities.docx'),{code:'unsupported'});
  for(const filename of ['../canary.txt','/canary.txt','word/../../canary.txt'])await assert.rejects(extract(zipSync({'word/document.xml':strToU8('<document><t>Safe</t></document>'),[filename]:strToU8('replacement')}),'traversal.docx'),{code:'malformed'});
  assert.equal(await readFile(path,'utf8'),marker);assert.deepEqual(await readdir(directory),['canary.txt']);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('EIG-154 PDF JavaScript is data and parser environment excludes parent secrets and loader hooks',async()=>{
 const document=await PDFDocument.create(),page=document.addPage([300,200]);page.drawText('Visible synthetic PDF');
 document.catalog.set(PDFName.of('OpenAction'),document.context.obj({S:PDFName.of('JavaScript'),JS:PDFString.of('throw new Error("SYNTHETIC_SCRIPT_EXECUTED")')}));
 const result=await extract(await document.save(),'active.pdf');assert.match(result.sections.map(s=>s.text).join('\n'),/Visible synthetic PDF/);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_SCRIPT_EXECUTED/);
 const selected=workerEnvironment({kind:'node',path:process.execPath});assert.deepEqual(Object.keys(selected).filter(key=>!['SystemRoot','WINDIR'].includes(key)),[]);
 assert.equal(workerEnvironment({kind:'electron',path:process.execPath}).ELECTRON_RUN_AS_NODE,'1');
});
