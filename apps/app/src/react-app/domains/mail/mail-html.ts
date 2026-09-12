import {rasterDimensions} from '../../../../../desktop/electron/mail-image-dimensions.mjs';
import DOMPurify from 'dompurify';
import {mailCss} from './mail-css';
export interface MailDocument {html:string; links:string[]; remote:string[]; limited:boolean}
export const MAIL_HTML_LIMIT=2*1024*1024;
const raster=/^data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/;
export function mailLink(value:string):string|null {try{if(value.length>4096)return null;const url=new URL(value);return ['https:','http:','mailto:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}}
/** Maps every resource to verified bytes; the isolated document never gets network permission. */
export function mailDocument(html:string,inline:ReadonlyMap<string,string>=new Map(),remote:ReadonlyMap<string,string>=new Map(),nonce?:string,imageBudget=16*1024*1024):MailDocument {
 if(nonce&&!/^[0-9a-f-]{36}$/.test(nonce))throw Error('Invalid mail frame nonce');
 let bridge='',imageBytes=0,imagePixels=0;const dimensions=new Map<string,number>();
 const links:string[]=[],resources=new Set<string>();let limited=html.length>MAIL_HTML_LIMIT;
 if(limited)html='<p>This HTML message exceeds the display limit. Use Plain text or save the original.</p>';
 const fragment=DOMPurify.sanitize(html,{WHOLE_DOCUMENT:true,RETURN_DOM:true,
  ALLOWED_TAGS:['html','head','body','style','p','br','div','span','strong','b','em','i','u','s','strike','small','big','font','center','blockquote','pre','code','ul','ol','li','dl','dt','dd','table','caption','colgroup','col','thead','tbody','tfoot','tr','td','th','hr','h1','h2','h3','h4','h5','h6','a','img','sup','sub','address'],
  ALLOWED_ATTR:['style','class','id','dir','lang','alt','title','src','href','background','colspan','rowspan','width','height','align','valign','bgcolor','border','cellpadding','cellspacing','face','color','size','type','start','reversed'],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false});
 if(!(fragment instanceof Element))throw Error('Mail document unavailable');
 const elements=fragment.querySelectorAll('*');
 if(elements.length>15000){limited=true;return {...mailDocument('<p>This message has too many layout elements. Use Plain text or save the original.</p>',inline,remote,nonce,imageBudget),limited};}
 const resource=(value:string)=>{
  const cid=value.match(/^cid:(.+)$/i)?.[1]?.replace(/^<|>$/g,'');
  let replacement=cid?inline.get(cid):undefined;
  if(!cid){const url=mailLink(value);if(url&&/^https?:/.test(url)){if(resources.size<100)resources.add(url);replacement=remote.get(url);}}
  if(!replacement||replacement.length>6*1024*1024||imageBytes+replacement.length>imageBudget||!raster.test(replacement))return null;
  if(!dimensions.has(replacement)){try{const bytes=Uint8Array.from(atob(replacement.slice(replacement.indexOf(',')+1)),char=>char.charCodeAt(0)),size=rasterDimensions(bytes);dimensions.set(replacement,size.width*size.height);}catch{dimensions.set(replacement,0);}}
  const pixels=dimensions.get(replacement)??0;if(!pixels||imagePixels+pixels>imageBudget)return null;imagePixels+=pixels;imageBytes+=replacement.length;return replacement;
 };
 for(const element of elements){
  if(element.tagName==='STYLE')element.textContent=mailCss(element.textContent??'',false,resource);
  if(element.hasAttribute('style'))element.setAttribute('style',mailCss(element.getAttribute('style')??'',true,resource));
  for(const attr of ['width','height','border','cellpadding','cellspacing','colspan','rowspan','size','start']){const value=element.getAttribute(attr);if(value&&!/^-?\d{1,5}(?:%|px)?$/.test(value))element.removeAttribute(attr);}
  if(element.hasAttribute('background')){const url=resource(element.getAttribute('background')??'');if(url)element.setAttribute('background',url);else element.removeAttribute('background');}
  if(element.tagName==='A'){
   const url=mailLink(element.getAttribute('href')??'');element.removeAttribute('href');
   if(url&&links.length<1000){element.setAttribute('data-mail-link',String(links.length));element.setAttribute('role','link');element.setAttribute('tabindex','0');element.setAttribute('title',url);links.push(url);}
  }
  if(element.tagName==='IMG'){
   const url=resource(element.getAttribute('src')??'');if(url)element.setAttribute('src',url);
   else {const placeholder=document.createElement('span');placeholder.setAttribute('data-mail-blocked','');placeholder.setAttribute('role','img');placeholder.setAttribute('aria-label',element.getAttribute('alt')||'Image blocked');placeholder.textContent=element.getAttribute('alt')||'Image blocked';
    placeholder.className=element.className;placeholder.setAttribute('style',element.getAttribute('style')??'');
    for(const dimension of ['width','height']){const value=element.getAttribute(dimension);if(value&&!placeholder.style.getPropertyValue(dimension))placeholder.style.setProperty(dimension,/^\d+$/.test(value)?value+'px':value);}
    const width=placeholder.style.width;if(width&&width!=='auto')placeholder.style.width='min(100%, '+width+')';
    placeholder.style.display='inline-flex';placeholder.style.alignItems='center';placeholder.style.justifyContent='center';placeholder.style.maxWidth='100%';placeholder.style.boxSizing='border-box';placeholder.style.overflow='hidden';element.replaceWith(placeholder);
   }
  }
 }
 const doc=document.implementation.createHTMLDocument('');
 const head=fragment.querySelector('head'),body=fragment.querySelector('body');
 if(body)doc.body.replaceWith(body);else doc.body.append(fragment);
 for(const root of [doc.documentElement,doc.body]){root.style.setProperty('height','auto','important');root.style.setProperty('min-height','0','important');root.style.setProperty('max-height','none','important');root.style.setProperty('overflow','visible','important');}
 const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src "+(nonce?"'nonce-"+nonce+"'":"'none'")+"; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'";
 doc.head.append(policy);
 const charset=doc.createElement('meta');charset.setAttribute('charset','utf-8');doc.head.append(charset);
 const color=doc.createElement('meta');color.name='color-scheme';color.content='light';doc.head.append(color);
 const defaults=doc.createElement('style');defaults.textContent='html{color-scheme:only light;background:#fff;color:#222}body{margin:8px;font-family:Arial,sans-serif;font-size:14px;overflow-wrap:break-word}a[data-mail-link]{cursor:pointer;color:#1656b8;text-decoration:underline}[data-mail-blocked]{background:#f3f4f6;color:#59616c;outline:1px solid #d9dde2;font:12px Arial}';doc.head.append(defaults);
 if(head)doc.head.append(...head.querySelectorAll('style'));
 if(nonce){const script=doc.createElement('script');script.setAttribute('nonce',nonce);script.setAttribute('style','display:none!important');script.textContent=`(()=>{const token=${JSON.stringify(nonce)};let queued=false,last=0;const size=()=>{queued=false;const b=document.body,s=getComputedStyle(b),height=Math.min(20000,Math.max(80,Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+(parseFloat(s.marginTop)||0)+(parseFloat(s.marginBottom)||0)+32+(document.documentElement.scrollWidth>innerWidth?20:0))));if(height!==last){last=height;parent.postMessage({type:'mail-size',token,height},'*');}};const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(size);}};new ResizeObserver(schedule).observe(document.body);addEventListener('load',schedule);addEventListener('resize',schedule);document.addEventListener('click',e=>{const a=e.target.closest?.('[data-mail-link]');if(a){e.preventDefault();if(e.isTrusted)parent.postMessage({type:'mail-link',token,index:Number(a.getAttribute('data-mail-link'))},'*');}});document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches?.('[data-mail-link]')){e.preventDefault();if(e.isTrusted)parent.postMessage({type:'mail-link',token,index:Number(e.target.getAttribute('data-mail-link'))},'*');}});schedule();})();`;bridge=script.outerHTML.replace('nonce=""','nonce="'+nonce+'"');}
 return {html:'<!doctype html>'+doc.documentElement.outerHTML.replace('</body>',bridge+'</body>'),links,remote:[...resources],limited};
}
export function mailHtml(html:string,inline:ReadonlyMap<string,string>=new Map()):string{return mailDocument(html,inline).html;}
export function boundedMailRaster(bytes:Uint8Array):string|null{try{return 'image/'+rasterDimensions(bytes).type;}catch{return null;}}
export function rasterType(bytes: Uint8Array): string | null {
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
        return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
        return 'image/jpeg';
    const start = new TextDecoder('ascii').decode(bytes.subarray(0, 12));
    if (start.startsWith('GIF87a') || start.startsWith('GIF89a'))
        return 'image/gif';
    if (start.startsWith('RIFF') && start.slice(8) === 'WEBP')
        return 'image/webp';
    return null;
}
export function safeFilename(value: string | null, fallback = 'attachment.bin'): string {
    const name = (value ?? fallback).replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 160);
    return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? 'mail-' + (name || fallback) : name;
}
