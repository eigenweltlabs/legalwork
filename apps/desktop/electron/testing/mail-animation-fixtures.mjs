import {crc32} from 'node:zlib';
export function animatedGif(frames=2,width=1,height=1){
 const header=Buffer.from('47494638396101000100800000000000ffffff','hex');header.writeUInt16LE(width,6);header.writeUInt16LE(height,8);
 const frame=Buffer.from('21f904040a0000002c0000000001000100000202440100','hex');
 return Buffer.concat([header,...Array.from({length:frames},()=>frame),Buffer.from([0x3b])]);
}
export function animatedPng(png,frames=2){
 const chunk=(kind,data)=>{const header=Buffer.alloc(8),crc=Buffer.alloc(4);header.writeUInt32BE(data.length);header.write(kind,4);crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(kind),data])));return Buffer.concat([header,data,crc]);};
 const ihdr=png.subarray(8,33),image=[];for(let offset=8;offset+12<=png.length;){const length=png.readUInt32BE(offset);if(png.toString('ascii',offset+4,offset+8)==='IDAT')image.push(png.subarray(offset+8,offset+8+length));offset+=length+12;}
 const actl=Buffer.alloc(8);actl.writeUInt32BE(frames);const output=[png.subarray(0,8),ihdr,chunk('acTL',actl)];let sequence=0;
 for(let index=0;index<frames;index++){const control=Buffer.alloc(26);control.writeUInt32BE(sequence++);control.writeUInt32BE(png.readUInt32BE(16),4);control.writeUInt32BE(png.readUInt32BE(20),8);control.writeUInt16BE(1,20);control.writeUInt16BE(10,22);output.push(chunk('fcTL',control));if(index===0)output.push(chunk('IDAT',Buffer.concat(image)));else{const prefix=Buffer.alloc(4);prefix.writeUInt32BE(sequence++);output.push(chunk('fdAT',Buffer.concat([prefix,...image])));}}
 return Buffer.concat([...output,chunk('IEND',Buffer.alloc(0))]);
}
