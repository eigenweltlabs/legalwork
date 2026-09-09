// Synthetic one-page PDF using the standard PDF revision-2 password algorithm.
// Test-only historical encrypted document; production never decrypts or creates this cipher.
import {createHash} from 'node:crypto';
export function encryptedPdf(){
 const padding=Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a','hex');
 const pad=value=>Buffer.concat([Buffer.from(value),padding]).subarray(0,32),md5=value=>createHash('md5').update(value).digest();
 const rc4=(key,input)=>{const box=Uint8Array.from({length:256},(_,i)=>i);let j=0;for(let i=0;i<256;i++){j=(j+box[i]+key[i%key.length])&255;[box[i],box[j]]=[box[j],box[i]];}let i=0;j=0;return Buffer.from(input.map(byte=>{i=(i+1)&255;j=(j+box[i])&255;[box[i],box[j]]=[box[j],box[i]];return byte^box[(box[i]+box[j])&255];}));};
 const identifier=Buffer.from('00112233445566778899aabbccddeeff','hex'),owner=rc4(md5(pad('owner')).subarray(0,5),pad('private-password'));
 const permissions=Buffer.alloc(4);permissions.writeInt32LE(-4);
 const fileKey=md5(Buffer.concat([pad('private-password'),owner,permissions,identifier])).subarray(0,5),user=rc4(fileKey,padding);
 const stream=rc4(md5(Buffer.concat([fileKey,Buffer.from([4,0,0,0,0])])).subarray(0,10),Buffer.from('BT /F1 12 Tf 20 50 Td (Private encrypted fixture) Tj ET'));
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',Buffer.concat([Buffer.from('<< /Length '+stream.length+' >>\nstream\n'),stream,Buffer.from('\nendstream')]),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`];
 const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let offset=chunks[0].length;for(const[index,object]of objects.entries()){offsets.push(offset);const chunk=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),Buffer.from(object),Buffer.from('\nendobj\n')]);chunks.push(chunk);offset+=chunk.length;}
 chunks.push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${identifier.toString('hex')}> <${identifier.toString('hex')}>] >>\nstartxref\n${offset}\n%%EOF`));return Buffer.concat(chunks);
}
