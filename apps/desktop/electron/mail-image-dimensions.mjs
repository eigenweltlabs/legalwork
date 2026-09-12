/** Read dimensions before handing compressed bytes to Chromium's decoder. */
export function rasterDimensions(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),text=(start,end)=>new TextDecoder('ascii').decode(bytes.subarray(start,end));
 let width,height,type;
 if(bytes.length>=24&&[137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value)){width=view.getUint32(16,false);height=view.getUint32(20,false);type='png';}
 else if(bytes.length>=10&&/^GIF8[79]a$/.test(text(0,6))){width=view.getUint16(6,true);height=view.getUint16(8,true);type='gif';}
 else if(bytes[0]===255&&bytes[1]===216){for(let i=2;i+8<bytes.length;){if(bytes[i++]!==255)break;while(bytes[i]===255)i++;const marker=bytes[i++];if(marker===0xda||marker===0xd9)break;if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;const length=view.getUint16(i,false);if(length<2||i+length>bytes.length)break;if([0xc0,0xc1,0xc2].includes(marker)){height=view.getUint16(i+3,false);width=view.getUint16(i+5,false);type='jpeg';break;}i+=length;}}
 else if(bytes.length>=30&&text(0,4)==='RIFF'&&text(8,12)==='WEBP'){
  const chunk=text(12,16);type='webp';
  if(chunk==='VP8X'){if(bytes[20]&2)throw Error('mail_image_animation');width=1+(bytes[24]|bytes[25]<<8|bytes[26]<<16);height=1+(bytes[27]|bytes[28]<<8|bytes[29]<<16);}
  else if(chunk==='VP8 '&&bytes[23]===0x9d&&bytes[24]===1&&bytes[25]===0x2a){width=view.getUint16(26,true)&0x3fff;height=view.getUint16(28,true)&0x3fff;}
  else if(chunk==='VP8L'&&bytes[20]===0x2f){width=1+(((bytes[22]&0x3f)<<8)|bytes[21]);height=1+(((bytes[24]&15)<<10)|(bytes[23]<<2)|(bytes[22]>>6));}
 }
 if(!type||!width||!height||width>4096||height>4096||width*height>4*1024*1024)throw Error('mail_image_dimensions');
 return {width,height,type};
}
