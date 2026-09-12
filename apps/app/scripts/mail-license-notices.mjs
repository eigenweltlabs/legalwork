// Mail's pinned dependency notices supplement existing office-editor notices.
// Run with pnpm exec node apps/app/scripts/mail-license-notices.mjs.
import {createRequire} from 'node:module';
import {readFileSync,readdirSync,existsSync,writeFileSync,realpathSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'..'),visited=new Set(),entries=[],declarations=[];
function visit(name,from){
 const require=createRequire(join(from,'package.json'));
 const candidate=(require.resolve.paths('legalwork-license-lookup')??[]).map(path=>join(path,name,'package.json')).find(existsSync);
 if(!candidate)throw Error('Cannot resolve mail dependency '+name);
 const path=realpathSync(candidate),pkg=JSON.parse(readFileSync(path,'utf8')),key=pkg.name+'@'+pkg.version,directory=dirname(path);
 if(visited.has(key))return;visited.add(key);
 const license=pkg.license??pkg.licenses?.map(value=>value.type).join(' OR ');if(!license)throw Error('Review license for '+key);
 const files=readdirSync(directory,{withFileTypes:true}).filter(file=>file.isFile()&&/^(licen[cs]e|notice|copying)([._-]|$)/i.test(file.name)).map(file=>file.name);
 // PDF.js bundles separately licensed fonts, colour profiles and decoder assets.
 if(pkg.name==='pdfjs-dist')for(const folder of ['standard_fonts','iccs','wasm','cmaps'])if(existsSync(join(directory,folder)))for(const file of readdirSync(join(directory,folder)))if(/^(licen[cs]e|notice|copying)([._-]|$)/i.test(file))files.push(folder+'/'+file);
 let supplemental='';
 if(!files.length&&pkg.name==='isarray')supplemental=readFileSync(join(directory,'README.md'),'utf8').split('## License')[1]??'';
 const missing={'saxes@6.0.0':'saxes-6.0.0-LICENSE.txt','tr46@0.0.3':'tr46-LICENSE.txt','@tesseract.js-data/deu@1.0.0':'tessdata-LICENSE.txt','@tesseract.js-data/eng@1.0.0':'tessdata-LICENSE.txt'};
 if(missing[key])supplemental=readFileSync(join(app,'scripts/mail-license-sources',missing[key]),'utf8');
 if(!files.length&&!supplemental)declarations.push(key);
 entries.push({key,license,source:pkg.repository??pkg.homepage??'',text:files.sort().map(file=>file+'\n'+readFileSync(join(directory,file),'utf8')).join('\n\n')||supplemental||'This published package includes a license declaration but no standalone notice file.'});
 for(const dependency of Object.keys(pkg.dependencies??{}).sort())visit(dependency,directory);
}
for(const name of ['dompurify','css-tree','jszip','@eigenpal/docx-editor-agents'])visit(name,app);
for(const name of ['@zone-eu/mailsplit','better-sqlite3-multiple-ciphers','fflate','iconv-lite','libmime','nodemailer','imapflow','saxes','pdf-lib','pdfjs-dist','tesseract.js','@tesseract.js-data/deu','@tesseract.js-data/eng','@napi-rs/canvas'])visit(name,join(app,'../server'));
visit('parse5',join(app,'../desktop'));
entries.sort((a,b)=>a.key.localeCompare(b.key,'en'));
const directory=join(app,'public/third-party/mail');mkdirSync(directory,{recursive:true});
writeFileSync(join(directory,'DEPENDENCY_LICENSES.txt'),('LegalWork mail dependency licenses and notices\nGenerated from the pinned installed production dependency graph (optional platform binaries retain their bundled notices).\nFor dual licenses offering MIT, this distribution uses MIT; DOMPurify uses Apache-2.0.\nNo GPL source from reference mail applications was copied. Package declarations without notice files are identified explicitly below.\n\n'+entries.map(entry=>'===== '+entry.key+' ('+JSON.stringify(entry.license)+') =====\nSource: '+JSON.stringify(entry.source)+'\n'+entry.text).join('\n\n')).replace(/\r\n/g,'\n').replace(/[ \t]+$/gm,''));
console.log(JSON.stringify({packages:entries.length,declarationsOnly:declarations.sort()}));
