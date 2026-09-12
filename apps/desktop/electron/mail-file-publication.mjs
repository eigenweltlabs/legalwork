import {link,open,lstat,rm} from 'node:fs/promises';
const filesystem={link,open,lstat,rm};
const unsupportedLink=new Set(['ENOTSUP','EOPNOTSUPP','ENOSYS','EPERM','EXDEV']);
/** Publish already-verified private bytes without replacing an intervening destination.
 * FAT/exFAT and some mounts need a non-atomic, exclusive-create copy fallback. */
export async function publishNewMailFile(source,destination,signal,io=filesystem){
  signal.throwIfAborted();
  try{await io.link(source,destination);return;}catch(error){if(!unsupportedLink.has(error.code))throw error;}
  signal.throwIfAborted();
  let writer,reader,identity,complete=false;
  try{
    writer=await io.open(destination,'wx',0o600);identity=await writer.stat({bigint:true});
    reader=await io.open(source,'r');const buffer=Buffer.allocUnsafe(64*1024);
    for(;;){
      signal.throwIfAborted();const {bytesRead}=await reader.read(buffer,0,buffer.length,null);if(!bytesRead)break;
      for(let offset=0;offset<bytesRead;){signal.throwIfAborted();const {bytesWritten}=await writer.write(buffer,offset,bytesRead-offset,null);if(!bytesWritten)throw Error('mail_copy_incomplete');offset+=bytesWritten;}
    }
    signal.throwIfAborted();await writer.sync();signal.throwIfAborted();complete=true;
  }finally{
    try{await reader?.close();}finally{try{await writer?.close();}finally{
      // An external replacement belongs to the user, not to this failed copy.
      if(!complete&&identity){let current;try{current=await io.lstat(destination,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}
        if(current?.dev===identity.dev&&current?.ino===identity.ino)await io.rm(destination,{force:true});}
    }}
  }
}
