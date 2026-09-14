import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,opendir,lstat,realpath} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';

export const PORTABLE_CHUNK_BYTES=65536;
/** File reads have one bounded buffer, including messages with multi-megabyte lines. */
export async function* fileChunks(path:string,start=0,end=Number.MAX_SAFE_INTEGER,signal?:AbortSignal):AsyncGenerator<Uint8Array>{
 const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
 try{if(!(await file.stat()).isFile())throw Error('archive_source_not_file');let offset=start;while(offset<end){signal?.throwIfAborted();const buffer=Buffer.alloc(Math.min(PORTABLE_CHUNK_BYTES,end-offset));const {bytesRead}=await file.read(buffer,0,buffer.length,offset);if(!bytesRead)break;offset+=bytesRead;yield buffer.subarray(0,bytesRead);}}
 finally{await file.close();}
}
export async function fingerprint(path:string,signal?:AbortSignal){const hash=createHash('sha256');let bytes=0;for await(const chunk of fileChunks(path,0,undefined,signal)){hash.update(chunk);bytes+=chunk.length;}return {sha256:hash.digest('hex'),bytes};}
export async function safeChild(root:string,name:string){
 if(!name||name.includes('\\')||name.includes('\0')||name.split('/').some(part=>!part||part==='.'||part==='..')||name.startsWith('/'))throw Error('invalid_archive_path');
 const base=await realpath(root),path=resolve(base,...name.split('/'));if(!path.startsWith(base+sep))throw Error('invalid_archive_path');
 // Reject every symlink component, including links that happen to resolve inside the archive.
 let current=base;for(const part of name.split('/')){current=join(current,part);if((await lstat(current)).isSymbolicLink())throw Error('archive_symlink');}
 if(await realpath(path)!==path)throw Error('archive_symlink');return path;
}
export async function* emlFiles(root:string,depth=0):AsyncGenerator<{path:string;entryId:string}>{
 if(depth>64)throw Error('archive_depth_limit');
 const base=await realpath(root);
 async function* walk(directory:string,level:number):AsyncGenerator<{path:string;entryId:string}>{
  if(level>64)throw Error('archive_depth_limit');const entries=await opendir(directory);
  for await(const entry of entries){if(entry.isSymbolicLink())throw Error('archive_symlink');const path=join(directory,entry.name);if(entry.isDirectory())yield* walk(path,level+1);else if(entry.isFile()&&entry.name.toLowerCase().endsWith('.eml'))yield{path,entryId:relative(base,path).split(sep).join('/')};}
 }
 yield* walk(base,depth);
}
/** mboxrd envelope detection, bounded even when an encoded attachment is one long line. */
export async function* mboxRanges(path:string,start=0,signal?:AbortSignal):AsyncGenerator<{entryId:string;start:number;end:number;nextOffset:number}>{
 let offset=start,lineStart=start,prefix=Buffer.alloc(0),messageStart:number|undefined,envelopeStart=start;
 const envelope=(value:Buffer)=>/^From [^\s]+ (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d{2}:\d{2}(?::\d{2})?(?: [^\r\n]+)? \d{4}\r?\n$/.test(value.toString('ascii'));
 for await(const chunk of fileChunks(path,start,undefined,signal)){
  let pos=0;while(pos<chunk.length){const nl=chunk.indexOf(10,pos),end=nl<0?chunk.length:nl+1;
   if(prefix.length<513)prefix=Buffer.concat([prefix,chunk.subarray(pos,Math.min(end,pos+513-prefix.length))]);offset+=end-pos;pos=end;
   if(nl>=0){if(prefix.length<=512&&envelope(prefix)){if(messageStart!==undefined)yield{entryId:String(envelopeStart),start:messageStart,end:lineStart,nextOffset:lineStart};else if(lineStart!==start)throw Error('unsupported_mbox_envelope');envelopeStart=lineStart;messageStart=offset;}prefix=Buffer.alloc(0);lineStart=offset;}
  }
 }
 if(messageStart===undefined){if(offset!==start)throw Error('unsupported_mbox_envelope');return;}
 yield{entryId:String(envelopeStart),start:messageStart,end:offset,nextOffset:offset};
}
/** Only line-leading >*From is transformed; no MIME decoding or newline normalization. */
export async function* mboxTransform(source:AsyncIterable<Uint8Array>|Iterable<Uint8Array>,encode:boolean,expectedBytes?:number):AsyncGenerator<Uint8Array>{
 let leading=true,arrows=0,prefix:number[]=[],total=0,padding=0;
 const word=[70,114,111,109,32];
 function* emit(chunk:Uint8Array){const available=expectedBytes===undefined?chunk.length:Math.min(chunk.length,Math.max(0,expectedBytes-total));if(expectedBytes!==undefined)for(let n=available;n<chunk.length;n++){if(chunk[n]!==10||++padding>1)throw Error('archive_invalid_framing');}for(let offset=0;offset<available;offset+=PORTABLE_CHUNK_BYTES){const piece=chunk.subarray(offset,Math.min(available,offset+PORTABLE_CHUNK_BYTES));total+=piece.length;yield piece;}}
 function* flush(match:boolean){let count=arrows+(match?(encode?1:arrows>0?-1:0):0);while(count>0){const amount=Math.min(PORTABLE_CHUNK_BYTES,count);yield* emit(Buffer.alloc(amount,62));count-=amount;}yield* emit(Uint8Array.from(prefix));arrows=0;prefix=[];}
 for await(const chunk of source){let offset=0;while(offset<chunk.length){if(!leading){const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline+1;yield* emit(chunk.subarray(offset,end));offset=end;if(newline>=0)leading=true;continue;}
  const byte=chunk[offset++];if(!prefix.length&&byte===62){arrows++;continue;}prefix.push(byte);if(byte===word[prefix.length-1]&&prefix.length<5)continue;yield* flush(prefix.length===5&&prefix.every((v,i)=>v===word[i]));leading=byte===10;
 }}
 yield* flush(false);if(expectedBytes!==undefined&&total!==expectedBytes)throw Error('archive_length_mismatch');
}
export async function* jsonLines(path:string,signal?:AbortSignal):AsyncGenerator<unknown>{let pending=Buffer.alloc(0);for await(const chunk of fileChunks(path,0,undefined,signal)){let begin=0;for(let index=0;index<chunk.length;index++){if(chunk[index]!==10)continue;const line=Buffer.concat([pending,chunk.subarray(begin,index)]);if(line.length>256*1024)throw Error('archive_manifest_limit');yield JSON.parse(line.toString('utf8'));pending=Buffer.alloc(0);begin=index+1;}pending=Buffer.concat([pending,chunk.subarray(begin)]);if(pending.length>256*1024)throw Error('archive_manifest_limit');}if(pending.length)throw Error('archive_manifest_incomplete');}

/** Node permits short writes. A zero-byte write is failure, never progress. */
export async function writeAll(file:Pick<Awaited<ReturnType<typeof open>>,'write'>,bytes:Uint8Array,position:number){let offset=0;while(offset<bytes.length){const result=await file.write(bytes,offset,bytes.length-offset,position+offset);if(result.bytesWritten<=0||result.bytesWritten>bytes.length-offset)throw Error('archive_short_write');offset+=result.bytesWritten;}return position+offset;}
/** POSIX rename durability. Windows does not expose an equivalent portable directory fsync. */
export async function syncDirectory(path:string){if(process.platform==='win32')return;const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}
/** Content-Length-framed variants need their own parser; never guess their boundaries. */
export async function* requireMboxrd(source:AsyncIterable<Uint8Array>):AsyncGenerator<Uint8Array>{let header=Buffer.alloc(0),checked=false;for await(const chunk of source){if(checked){yield chunk;continue;}header=Buffer.concat([header,chunk]);const crlf=header.indexOf('\r\n\r\n'),lf=header.indexOf('\n\n'),end=crlf<0?lf:lf<0?crlf:Math.min(crlf,lf);if(end<0){if(header.length>128*1024)throw Error('unsupported_mbox_headers');continue;}if(/^content-length\s*:/im.test(header.subarray(0,end).toString('latin1')))throw Error('unsupported_mbox_content_length');for(let n=0;n<header.length;n+=PORTABLE_CHUNK_BYTES)yield header.subarray(n,n+PORTABLE_CHUNK_BYTES);header=Buffer.alloc(0);checked=true;}if(!checked){if(/^content-length\s*:/im.test(header.toString('latin1')))throw Error('unsupported_mbox_content_length');for(let n=0;n<header.length;n+=PORTABLE_CHUNK_BYTES)yield header.subarray(n,n+PORTABLE_CHUNK_BYTES);}}
