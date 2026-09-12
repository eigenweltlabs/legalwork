/** Read dimensions before handing compressed bytes to Chromium's decoder. */
export function rasterDimensions(bytes){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),text=(start,end)=>new TextDecoder('ascii').decode(bytes.subarray(start,end));
 let width,height,type,frames=1;
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
 // Count encoded animation frames without decoding any raster. Budget every
 // frame at the full canvas size, including disposal/compositing surfaces.
 if(type==='png'){
  if(bytes.length<33||view.getUint32(8,false)!==13||text(12,16)!=='IHDR')throw Error('mail_image_container');
  let offset=8,declared=0,controls=0,ended=false;
  while(offset+12<=bytes.length){const length=view.getUint32(offset,false),kind=text(offset+4,offset+8);if(length>bytes.length-offset-12)throw Error('mail_image_container');
   if(kind==='IHDR'&&offset!==8)throw Error('mail_image_container');
   if(kind==='acTL'){if(declared||length!==8)throw Error('mail_image_animation');declared=view.getUint32(offset+8,false);if(!declared||declared>128)throw Error('mail_image_animation');}
   if(kind==='fcTL'){if(length!==26||++controls>128)throw Error('mail_image_animation');const w=view.getUint32(offset+12,false),h=view.getUint32(offset+16,false),x=view.getUint32(offset+20,false),y=view.getUint32(offset+24,false);if(!w||!h||x+w>width||y+h>height)throw Error('mail_image_dimensions');}
   offset+=12+length;if(kind==='IEND'){ended=true;break;}
  }
  if(!ended||controls!==declared)throw Error('mail_image_container');
  // APNG may keep its default IDAT image outside the animation sequence.
  frames=declared?declared+1:1;
 }else if(type==='gif'){
  if(bytes.length<13)throw Error('mail_image_container');let offset=13+(bytes[10]&128?3*(1<<((bytes[10]&7)+1)):0),count=0,ended=false;
  const skipBlocks=()=>{while(offset<bytes.length){const length=bytes[offset++];if(!length)return;if(length>bytes.length-offset)throw Error('mail_image_container');offset+=length;}throw Error('mail_image_container');};
  while(offset<bytes.length){const kind=bytes[offset++];if(kind===0x3b){ended=true;break;}if(kind===0x21){if(offset>=bytes.length)throw Error('mail_image_container');offset++;skipBlocks();continue;}if(kind!==0x2c||offset+9>bytes.length)throw Error('mail_image_container');
   if(++count>128)throw Error('mail_image_animation');const left=view.getUint16(offset,true),top=view.getUint16(offset+2,true),w=view.getUint16(offset+4,true),h=view.getUint16(offset+6,true),flags=bytes[offset+8];if(!w||!h||left+w>width||top+h>height)throw Error('mail_image_dimensions');offset+=9+(flags&128?3*(1<<((flags&7)+1)):0);if(offset>=bytes.length)throw Error('mail_image_container');offset++;skipBlocks();
  }
  if(!ended||!count)throw Error('mail_image_container');frames=count;
 }
 const pixels=width*height*frames;if(pixels>4*1024*1024)throw Error('mail_image_animation');
 return {width,height,type,frames,pixels};
}
