import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { combinedDenyTarget } from './deny-ocr.mjs';
const dimensions={width:1600,height:1000,scale:4,minimumConfidence:80};
const tsv=rows=>['level\tleft\ttop\twidth\theight\tconf\ttext',...rows.map(row=>[5,...row].join('\t'))].join('\n');
const pair=(gray=[],red=[])=>[{method:'grayscale',tsv:tsv(gray)},{method:'red-ink',tsv:tsv(red)}];
const deny=[2280,1400,128,56,96.7,'Deny'];
test('both full-frame methods are required and no spatial crop is accepted',()=>{
 assert.throws(()=>combinedDenyTarget(pair([deny]).slice(0,1),dimensions),/Explicit/);
 assert.throws(()=>combinedDenyTarget([{...pair([deny])[0],crop:{left:400}},pair()[1]],dimensions),/full-image/);
 assert.throws(()=>combinedDenyTarget([pair([deny])[0],pair()[0]],dimensions),/full-image/);
});
test('whole-frame fallback recognizes missed red label at unchanged confidence boundary',()=>{
 const value=combinedDenyTarget(pair([],[deny]),dimensions);
 assert.deepEqual(value.target.rectangle,{left:570,top:350,width:32,height:14});
 assert.equal(value.target.x,586);
 assert.throws(()=>combinedDenyTarget(pair([],[[...deny.slice(0,4),79.99,'Deny']]),dimensions),/Uncertain/);
 assert.throws(()=>combinedDenyTarget(pair(),dimensions),/Exactly one/);
});
test('only near-identical physical rectangles across methods merge',()=>{
 const result=combinedDenyTarget(pair([deny],[[2281,1401,129,57,98,'Deny']]),dimensions);
 assert.equal(result.physicalLabelGroups.length,1);assert.equal(result.physicalLabelGroups[0].length,2);
 assert.equal(result.target.confidence,98);
 assert.throws(()=>combinedDenyTarget(pair([deny],[[2296,1400,128,56,99,'Deny']]),dimensions),/Exactly one/);
 assert.throws(()=>combinedDenyTarget(pair([[400,400,4,56,96,'Deny']],[[408,400,4,56,99,'Deny']]),dimensions),/Exactly one/);
});
test('a recognized unrelated black Deny cannot hide the red button or a low-confidence distinct label',()=>{
 const second=[3480,1400,128,56,99,'Deny'];
 assert.throws(()=>combinedDenyTarget(pair([deny],[second]),dimensions),/Exactly one/);
 assert.throws(()=>combinedDenyTarget(pair([deny,second],[deny]),dimensions),/Exactly one/);
 assert.throws(()=>combinedDenyTarget(pair([deny,[3480,1400,128,56,20,'Deny']],[deny]),dimensions),/Exactly one/);
 assert.throws(()=>combinedDenyTarget(pair([deny,deny],[deny]),dimensions),/Ambiguous/);
});
test('malformed headers, rows, candidate types and offscreen rectangles fail closed',()=>{
 assert.throws(()=>combinedDenyTarget([{method:'grayscale',tsv:'text\nDeny'},pair()[1]],dimensions),/Malformed/);
 assert.throws(()=>combinedDenyTarget([{method:'grayscale',tsv:tsv([deny])+'\n5\t1'},pair()[1]],dimensions),/Malformed/);
 for(const row of [[-1,1400,128,56,96,'Deny'],[6390,1400,128,56,96,'Deny'],[2280,1400,0,56,96,'Deny'],[2280,1400,128,56,'bad','Deny']])assert.throws(()=>combinedDenyTarget(pair([],[row]),dimensions),/Malformed\/offscreen/);
});
test('actual interrupted full-frame TSVs recover only the visible red label',()=>{
 const gray=readFileSync(new URL('./test-fixtures/deny-ocr/split-gray.tsv',import.meta.url),'utf8');
 const red=readFileSync(new URL('./test-fixtures/deny-ocr/split-red.tsv',import.meta.url),'utf8');
 const result=combinedDenyTarget([{method:'grayscale',tsv:gray},{method:'red-ink',tsv:red}],dimensions);
 assert.equal(result.observations[0].candidates.length,0);
 assert.equal(result.target.confidence,95.974831);
 assert.deepEqual(result.target.rectangle,{left:568.75,top:350.75,width:33.25,height:14.5});
});
test('valid Tesseract empty-text rows produce no target without losing their trailing column',()=>{
 const empty='level\tleft\ttop\twidth\theight\tconf\ttext\n1\t0\t0\t6400\t4000\t-1\t\n';
 assert.throws(()=>combinedDenyTarget([{method:'grayscale',tsv:empty},{method:'red-ink',tsv:empty}],dimensions),/Exactly one/);
});
