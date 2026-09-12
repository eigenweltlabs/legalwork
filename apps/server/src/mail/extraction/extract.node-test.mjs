import {encryptedPdf} from './encrypted-pdf-fixture.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {PDFDocument,StandardFonts} from 'pdf-lib';import {createCanvas} from '@napi-rs/canvas';import {zipSync,strToU8} from 'fflate';
import {extractInProcess} from './client.js';import {EXTRACTION_LIMITS} from './contract.js';
const extract=(bytes,filename,contentType='application/octet-stream')=>extractInProcess({bytes,filename,contentType,signal:new AbortController().signal});
const words=result=>result.sections.map(section=>section.text).join('\n');
test('isolated text and Office extraction preserves Unicode and section provenance',async()=>{
 assert.equal(words(await extract(Buffer.from('Kündigung § 138 AZ-12/34.5'),'brief.txt')),'Kündigung § 138 AZ-12/34.5');
 const fixtures=[['brief.docx','word/document.xml','<w:document xmlns:w="urn:w"><w:p><w:r><w:t>Vertrag</w:t></w:r></w:p></w:document>'],['brief.pptx','ppt/slides/slide1.xml','<a:p xmlns:a="urn:a"><a:r><a:t>Vertrag</a:t></a:r></a:p>'],['brief.xlsx','xl/worksheets/sheet1.xml','<worksheet><row><c t="inlineStr"><is><t>Vertrag</t></is></c></row></worksheet>']];
 for(const [filename,path,xml]of fixtures){const result=await extract(zipSync({[path]:strToU8(xml)}),filename);assert.equal(words(result),'Vertrag');assert.equal(result.sections[0].source,path);}
});
test('actual PDF text and scanned PDF OCR run offline in private processes',async()=>{
 const text=await PDFDocument.create(),page=text.addPage([500,200]),font=await text.embedFont(StandardFonts.Helvetica);page.drawText('Contract 138 unique PDF text',{x:20,y:100,font,size:20});
 const result=await extract(await text.save(),'contract.pdf');assert.match(words(result),/unique PDF text/);assert.equal(result.sections[0].method,'text');assert.equal(result.sections[0].source,'page:1');
 const canvas=createCanvas(1000,220),context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,1000,220);context.fillStyle='black';context.font='60px Arial';context.fillText('CONTRACT ATTACHMENT 138',20,125);
 const scan=await PDFDocument.create(),image=await scan.embedPng(canvas.toBuffer('image/png'));const scannedPage=scan.addPage([500,140]);scannedPage.drawImage(image,{x:0,y:0,width:500,height:110});scannedPage.drawText('BATES 001',{x:10,y:125,size:8});
 const recognized=await extract(await scan.save(),'scan.pdf');assert.match(words(recognized),/CONTRACT ATTACHMENT 138/);assert.ok(recognized.sections.some(section=>section.method==='ocr'&&section.text.includes('CONTRACT')));assert.ok(recognized.sections.some(section=>section.method==='text'&&section.text.includes('BATES 001')));
});
test('bounded stdout preserves Unicode across multiple pipe chunks',async()=>{const text='§ Kündigung ÄÖÜ ß — '.repeat(7000);assert.equal(words(await extract(Buffer.from(text),'unicode.txt')),text);});
test('unsupported, malformed, expanded-byte and page budgets fail visibly',async()=>{
 await assert.rejects(extract(encryptedPdf(),'password.pdf'),{code:'encrypted'});
 await assert.rejects(extract(Buffer.from('binary'),'old.doc'),{code:'unsupported'});
 await assert.rejects(extract(Buffer.from('%PDF-broken'),'broken.pdf'),{code:'malformed'});
 await assert.rejects(extract(zipSync({'word/document.xml':strToU8('a'.repeat(EXTRACTION_LIMITS.entryBytes+1))}),'bomb.docx'),{code:'limit'});
 const pdf=await PDFDocument.create();for(let index=0;index<=EXTRACTION_LIMITS.pages;index++)pdf.addPage([10,10]);await assert.rejects(extract(await pdf.save(),'too-many.pdf'),{code:'limit'});
 const canvas=createCanvas(2100,2100),oversized=await PDFDocument.create(),image=await oversized.embedPng(canvas.toBuffer('image/png'));oversized.addPage([100,100]).drawImage(image,{x:0,y:0,width:100,height:100});await assert.rejects(extract(await oversized.save(),'oversized-image.pdf'),{code:'limit'});
 await assert.rejects(extract(Buffer.from([255,254,0]),'invalid.txt'),{code:'malformed'});
});
test('cancellation kills and reaps an actual extraction process before accepting a late result',async()=>{
 const abort=new AbortController();const promise=extractInProcess({bytes:Buffer.from('text'),filename:'file.txt',contentType:'text/plain',signal:abort.signal});abort.abort();await assert.rejects(promise,{code:'cancelled'});
});

test('focused actual Electron extraction process resolves canvas, WASM and local bilingual models',async()=>{
 const require=createRequire(process.cwd()+'/../desktop/package.json'),electron=process.env.LEGALWORK_MAIL_TEST_ELECTRON??require('electron');
 const canvas=createCanvas(1000,220),context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,1000,220);context.fillStyle='black';context.font='60px Arial';context.fillText('Kündigung Contract 138',20,125);
 const result=await extractInProcess({bytes:canvas.toBuffer('image/png'),filename:'scan.png',contentType:'image/png',signal:new AbortController().signal},{kind:'electron',path:electron});
 assert.match(words(result),/Kündigung Contract 138/);assert.equal(result.sections[0].method,'ocr');
});

test('trusted shorter deadline kills and reaps the actual parser process',async()=>{
 const started=performance.now();await assert.rejects(extractInProcess({bytes:Buffer.from('bounded'),filename:'text.txt',contentType:'text/plain',signal:new AbortController().signal},{kind:'node',path:process.execPath},10),{code:'timeout'});assert.ok(performance.now()-started<3000);
});
