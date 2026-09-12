import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rasterDimensions} from './mail-image-dimensions.mjs';
import {animatedGif,animatedPng} from './testing/mail-animation-fixtures.mjs';
const png=await readFile(new URL('../../server/src/mail/testing/html-fixtures/brand.png',import.meta.url));
test('small GIF/APNG animations remain supported and charge their complete frame canvas budget',()=>{
 assert.deepEqual(rasterDimensions(animatedGif()),{width:1,height:1,type:'gif',frames:2,pixels:2});
 assert.deepEqual(rasterDimensions(animatedPng(png)),{width:72,height:40,type:'png',frames:3,pixels:8640});
});
test('animation count, canvas amplification, truncated containers and hidden frame declarations fail before decode',()=>{
 for(const bytes of [animatedGif(129),animatedGif(2,2048,2048),animatedGif().subarray(0,-1),animatedPng(png,129)])assert.throws(()=>rasterDimensions(bytes),/mail_image_/);
 const large=Buffer.from(png);large.writeUInt32BE(2048,16);large.writeUInt32BE(2048,20);assert.throws(()=>rasterDimensions(animatedPng(large)),/animation/);
 const malformed=animatedPng(png);const offset=malformed.indexOf(Buffer.from('acTL'));malformed.writeUInt32BE(1,offset+4);assert.throws(()=>rasterDimensions(malformed),/container/);
});
