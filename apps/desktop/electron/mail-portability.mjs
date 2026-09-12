import {basename} from 'node:path';
let service;
export function configureMailPortability(value){service=value;}
/** Native-only path grant. Renderer input cannot supply a filesystem path or owner. */
export async function performMailPortability(value,dialog){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid mail archive request');
 const keys=Object.keys(value),operation=value.operation;
 const expected=operation==='list'?['operation']:operation==='pause'||operation==='resume'?['operation','id']:operation==='import'?['operation','format']:operation==='export'?['operation','format','accountId']:[];
 if(keys.length!==expected.length||!expected.every(key=>Object.hasOwn(value,key)))throw Error('Invalid mail archive request');
 if(!service||service.status().state!=='ready')throw Error('Mail archive is unavailable');const target=service;
 if(operation==='list')return target.portability({operation:'mail.portability.list'});
 if(operation==='pause'||operation==='resume'){if(typeof value.id!=='string'||!/^[0-9a-f-]{36}$/.test(value.id))throw Error('Invalid archive job');return target.portability({operation:`mail.portability.${operation}`,id:value.id});}
 if(operation==='import'?!['eml','mboxrd','bundle'].includes(value.format):!['eml','mboxrd'].includes(value.format)||typeof value.accountId!=='string'||!value.accountId||value.accountId.length>4096)throw Error('Invalid archive format');
 const directory=operation==='export'||value.format==='bundle'||value.format==='eml';
 const chosen=await dialog.showOpenDialog({title:operation==='export'?'Choose a folder for the portable mail archive':value.format==='eml'?'Choose a folder containing EML files':value.format==='bundle'?'Choose a LegalWork mail archive folder':'Choose an mboxrd mailbox',properties:[directory?'openDirectory':'openFile'],...(directory?{}:{filters:[{name:'MBOX mailbox',extensions:['mbox','mbx']}]})});
 if(chosen.canceled)return target.portability({operation:'mail.portability.list'});
 if(chosen.filePaths.length!==1||service!==target||target.status().state!=='ready')throw Error('Mail archive is unavailable');
 return target.portability(operation==='import'?{operation:'mail.portability.import',path:chosen.filePaths[0],format:value.format,label:basename(chosen.filePaths[0])||'Imported mail'}:{operation:'mail.portability.export',path:chosen.filePaths[0],format:value.format,accountId:value.accountId});
}
