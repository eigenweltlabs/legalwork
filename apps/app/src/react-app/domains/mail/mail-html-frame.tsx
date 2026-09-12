import {useEffect,useMemo,useRef,useState} from 'react';
import {z} from 'zod';
import {mailDocument,mailLink} from './mail-html';
import type {MailMessageView,MailPartView} from './mail-client';
const imageResult=z.object({items:z.array(z.object({url:z.string().max(4096),data:z.string().max(6*1024*1024)})).max(30),failed:z.number().int().min(0).max(100)});
type FrameProps={html:string;inline:ReadonlyMap<string,string>;item:MailMessageView;bodyPart?:MailPartView;signal:AbortSignal;imageBudget?:number};
/** Legacy envelopes lack MIME ancestry: retain every section rather than guessing away text. */
export function MailHtmlParts({bodies,...props}:{bodies:{text:string;presentation?:boolean}[]}&Omit<FrameProps,'html'>){
 const [page,setPage]=useState(0),visible=bodies.filter(body=>body.presentation!==false),shown=visible.slice(page*10,page*10+10);
 return <>{shown.map((body,index)=><section key={page*10+index}>{visible.length>1&&<p className="mail-html-part-label">Message part {page*10+index+1} of {visible.length}</p>}<MailHtmlFrame {...props} imageBudget={Math.floor(16*1024*1024/shown.length)} html={body.text}/></section>)}{visible.length>10&&<nav aria-label="Message parts"><button disabled={!page} onClick={()=>setPage(value=>value-1)}>Previous parts</button><button disabled={(page+1)*10>=visible.length} onClick={()=>setPage(value=>value+1)}>Next parts</button></nav>}</>;
}
/** Opaque origin, no sender script. Only the nonce-bearing sizing/link bridge runs. */
export function MailHtmlFrame({html,inline,item,bodyPart,signal,imageBudget}:FrameProps){
 const frame=useRef<HTMLIFrameElement>(null),[height,setHeight]=useState(160),[images,setImages]=useState<ReadonlyMap<string,string>>(new Map()),[loading,setLoading]=useState(false),[error,setError]=useState(''),[link,setLink]=useState<string|null>(null);
 const nonce=useMemo(()=>crypto.randomUUID(),[html,inline,images,item.accountId,item.key]);
 const rendered=useMemo(()=>mailDocument(html,inline,images,nonce,imageBudget),[html,inline,images,nonce,imageBudget]);
 useEffect(()=>{setHeight(160);const listener=(event:MessageEvent)=>{
  if(signal.aborted||event.source!==frame.current?.contentWindow||event.origin!=='null')return;
  const value:unknown=event.data;if(!value||typeof value!=='object'||!('token' in value)||value.token!==nonce||!('type' in value))return;
  if(value.type==='mail-size'&&'height' in value&&typeof value.height==='number'&&Number.isInteger(value.height)&&value.height>=80&&value.height<=20000)setHeight(value.height);
  if(value.type==='mail-link'&&'index' in value&&typeof value.index==='number'&&Number.isSafeInteger(value.index)&&value.index>=0&&value.index<rendered.links.length)setLink(rendered.links[value.index]);
 };window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener);},[nonce,rendered,signal]);
 useEffect(()=>()=>{void window.__LEGALWORK_ELECTRON__?.mailImagesCancel?.();},[]);
 async function load(){if(!bodyPart?.referenceId||!window.__LEGALWORK_ELECTRON__?.mailImages)return;setLoading(true);setError('');try{
  const result=imageResult.parse(await window.__LEGALWORK_ELECTRON__.mailImages({accountId:item.accountId,locator:item.locator,referenceId:bodyPart.referenceId,partId:bodyPart.partId}));
  if(!signal.aborted){setImages(new Map(result.items.map(value=>[value.url,value.data])));if(result.failed)setError(`${result.failed} images could not be loaded safely.`);}
 }catch{if(!signal.aborted)setError('Images could not be loaded. Try again or keep them blocked.');}finally{if(!signal.aborted)setLoading(false);}}
 return <div className="mail-html-view">
  {rendered.remote.length>0&&<div className="mail-image-controls"><span>{images.size?'External images loaded for this message.':'Images are blocked. Loading them may notify the sender.'}</span>{window.__LEGALWORK_ELECTRON__?.mailImages&&<button disabled={loading||signal.aborted} onClick={()=>{if(images.size){setImages(new Map());setError('');}else void load();}}>{loading?'Loading images…':images.size?'Hide external images':'Load images'}</button>}</div>}
  {error&&<p role="status">{error}</p>}
  {link&&<div className="mail-link-controls" role="dialog" aria-label="Open message link"><span>{link}</span><button onClick={()=>{const url=mailLink(link);if(url)void window.__LEGALWORK_ELECTRON__?.shell?.openExternal?.(url);setLink(null);}}>Open link</button><button onClick={()=>setLink(null)}>Cancel</button></div>}
  {height>=20000&&<p>Long message: scroll within the message to read the remaining content.</p>}
  <iframe ref={frame} title="Message HTML" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={rendered.html} style={{height,minHeight:80}}/>
 </div>;
}
