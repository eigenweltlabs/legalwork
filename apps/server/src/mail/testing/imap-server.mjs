import {createServer} from 'node:tls';
import {readFile} from 'node:fs/promises';
export const original=Buffer.from('From: Sender <sender@example.test>\r\nSubject: IMAP synthetic\r\nMessage-ID: <copy@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="part"\r\n\r\n--part\r\nContent-Type: text/plain\r\n\r\nOriginal synthetic mail\r\n--part\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="evidence.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\nAQID\r\n--part--\r\n');
export async function imapServer(){
 const key=await readFile(new URL('./imap/key.pem',import.meta.url)),cert=await readFile(new URL('./imap/cert.pem',import.meta.url));
 const state={validity:7,rejectAuth:false,hangRaw:false,rawCalls:0,rawAttempts:0,commands:[],connections:0,maxConnections:0,messages:{INBOX:[1,1002],Archive:[1]},sockets:new Set()};
 const server=createServer({key,cert},socket=>{state.sockets.add(socket);state.connections++;state.maxConnections=Math.max(state.maxConnections,state.connections);socket.on('close',()=>{state.sockets.delete(socket);state.connections--;});socket.on('error',()=>{});socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] Synthetic IMAP\r\n');let buffer='',mailbox='INBOX';
 socket.on('data',chunk=>{buffer+=chunk.toString();while(buffer.includes('\r\n')){const i=buffer.indexOf('\r\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+2);const match=/^(\S+)\s+(.*)$/.exec(line);if(!match)continue;const [,tag,command]=match;const verb=command.split(' ')[0].toUpperCase();state.commands.push(verb);const done=()=>socket.write(tag+' OK completed\r\n');
 if(verb==='CAPABILITY'){socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n');done();}
 else if(verb==='AUTHENTICATE'){if(state.rejectAuth)socket.write(tag+' NO [AUTHENTICATIONFAILED] SYNTHETIC_SECRET_PROVIDER_ERROR\r\n');else done();}
 else if(verb==='LIST'||verb==='LSUB'){if(command.endsWith('""'))socket.write(`* ${verb} (\\Noselect) "/" ""\r\n`);else socket.write(`* ${verb} (\\HasNoChildren) "/" "INBOX"\r\n* ${verb} (\\Archive \\HasNoChildren) "/" "Archive"\r\n`);done();}
 else if(verb==='EXAMINE'||verb==='SELECT'){mailbox=command.slice(verb.length).trim().replace(/^"|"$/g,'');const ids=state.messages[mailbox]??[];socket.write(`* FLAGS (\\Seen)\r\n* ${ids.length} EXISTS\r\n* OK [UIDVALIDITY ${state.validity}] Validity\r\n* OK [UIDNEXT ${(ids.at(-1)??0)+1}] Next\r\n${tag} OK [READ-ONLY] opened\r\n`);}
 else if(verb==='UID'&&command.startsWith('UID FETCH')){const range=command.split(' ')[2],parts=range.split(':').map(Number),from=parts[0],to=parts[1]??from,ids=state.messages[mailbox]??[];
  if(command.includes('BODY.PEEK[')){state.rawAttempts++;if(state.hangRaw)continue;}
  for(let n=0;n<ids.length;n++){const uid=ids[n];if(uid<from||uid>to)continue;if(command.includes('BODY.PEEK[')){state.rawCalls++;const partial=/<(\d+)\.(\d+)>/.exec(command),offset=Number(partial?.[1]??0),count=Number(partial?.[2]??original.length),bytes=original.subarray(offset,offset+count);socket.write(`* ${n+1} FETCH (UID ${uid} BODY[]<${offset}> {${bytes.length}}\r\n`);socket.write(bytes);socket.write(')\r\n');}else if(command.includes('RFC822.SIZE'))socket.write(`* ${n+1} FETCH (UID ${uid} RFC822.SIZE ${original.length})\r\n`);else socket.write(`* ${n+1} FETCH (UID ${uid} FLAGS (\\Seen) INTERNALDATE "09-Sep-2026 10:00:00 +0000")\r\n`);}
  done();
 }else if(verb==='LOGOUT'){socket.end('* BYE logout\r\n'+tag+' OK logout\r\n');}else if(verb==='NOOP'||verb==='CLOSE'||verb==='UNSELECT')done();else socket.write(tag+' BAD unsupported fixture command\r\n');
 }});
 });server.on('tlsClientError',()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {state,cert,port:server.address().port,async close(){for(const socket of state.sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
