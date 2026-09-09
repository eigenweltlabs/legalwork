import { decodeHTML } from "entities";
import { z } from "zod";
import type { MailDatabase, MailSqlValue } from "./database-interface.js";
import { MailContentStore } from "./content-store.js";
import { MimeProjectionStore } from "./mime-projection-store.js";
import { providerMessageLocatorSchema } from "../model.js";
import { mailSearchInputSchema, mailSearchResultSchema, mailSearchRebuildInputSchema, type MailSearchInput, type MailSearchRebuildInput } from "../search-view.js";
export class MailSearchError extends Error {
  constructor(readonly code:"not_found"|"locked"|"unsupported"|"invalid_input"|"unavailable") {super(`mail_search_${code}`);}
}
const string = z.string(), count = z.number().int().nonnegative();
const normalize = (value:string)=>value.normalize("NFC").toLowerCase();
const quote = (value:string)=>`"${value.normalize('NFC').replaceAll('"','""')}"`;
/** Split mailbox lists without interpreting quoted display names as addresses. */
function addresses(header:string|null):string[]{
  if (!header) return [];
  const parts:string[]=[];let part='',quoted=false,escaped=false,angle=false,comment=0;
  for(const char of header){
    if(escaped){if(!comment)part+=char;escaped=false;continue;}
    if(char==='\\'&&(quoted||comment)){if(!comment)part+=char;escaped=true;continue;}
    if(comment){if(char==='(')comment++;if(char===')')comment--;continue;}
    if(char==='"'){quoted=!quoted;part+=char;continue;}
    if(!quoted){
      if(char==='('){comment++;continue;}
      if(char==='<')angle=true;if(char==='>')angle=false;
      if(!angle&&(char===','||char===';')){parts.push(part);part='';continue;}
      if(!angle&&char===':'){part='';continue;}
    }
    part+=char;
  }
  if(!quoted&&!comment&&!angle)parts.push(part);
  const result:string[]=[];
  for(const item of parts){
    let quoted=false,escaped=false,start=-1,end=-1;
    for(let index=0;index<item.length;index++){
      const char=item[index];if(escaped){escaped=false;continue;}if(char==='\\'&&quoted){escaped=true;continue;}
      if(char==='"')quoted=!quoted;else if(!quoted&&char==='<')start=index;else if(!quoted&&char==='>')end=index;
    }
    const candidate=(start>=0&&end>start?item.slice(start+1,end):item).trim();
    if(/^(?:[^\s<>(),;:"]+|"(?:[^"\\]|\\.)+")@[^\s<>(),;:"]+$/u.test(candidate))result.push(normalize(candidate));
  }
  return [...new Set(result)];
}
function htmlText(value:string):string{
  const lower=value.replace(/[A-Z]/g,char=>char.toLowerCase()),parts:string[]=[];let cursor=0;
  // Every search starts after the previous consumed span. Unclosed script/style
  // consumes the remainder once; repeated openings cannot restart a suffix scan.
  while(cursor<value.length){
    const opening=value.indexOf('<',cursor);if(opening<0){parts.push(value.slice(cursor));break;}
    parts.push(value.slice(cursor,opening));const end=value.indexOf('>',opening+1);if(end<0)break;
    const tag=lower.slice(opening+1,Math.min(end,opening+32)).trim().split(/[\s/]/,1)[0];
    if(tag==='script'||tag==='style'){
      const closing=lower.indexOf('</'+tag,end+1);if(closing<0)break;
      const closed=value.indexOf('>',closing+2);if(closed<0)break;cursor=closed+1;
    }else cursor=end+1;
    parts.push(' ');
  }
  return decodeHTML(parts.join(''));
}
/** Search and rebuild are synchronous worker operations over encrypted, locally published content only. */
export class MailSearchStore {
  constructor(private readonly db:MailDatabase,private readonly ownerId:string){}
  private account(accountId:string){
    const row=this.db.get("SELECT a.provider,c.state FROM mail_accounts a LEFT JOIN mail_account_credentials c ON c.account_id=a.id WHERE a.id=? AND a.owner_id=?",[accountId,this.ownerId]);
    if(!row)throw new MailSearchError("not_found");if(row.state==='disconnected')throw new MailSearchError("locked");return row;
  }
  private safe<T>(fn:()=>T):T{try{return fn();}catch(error){if(error instanceof MailSearchError)throw error;throw new MailSearchError("unavailable");}}
  private stats(accounts:string[]){const marks=accounts.map(()=>'?').join(',');if(!accounts.length)return{pending:0,incomplete:0};return{
    pending:count.parse(this.db.get(`SELECT count(*) AS n FROM mail_search_dirty WHERE account_id IN (${marks})`,accounts)?.n),
    incomplete:count.parse(this.db.get(`SELECT count(*) AS n FROM mail_search_documents d WHERE account_id IN (${marks}) AND incomplete=1 AND NOT EXISTS(SELECT 1 FROM mail_search_dirty q WHERE q.account_id=d.account_id AND q.message_key=d.message_key)`,accounts)?.n),
  };}
  rebuild(supplied:MailSearchRebuildInput){return this.safe(()=>this.db.transaction(()=>{
    const parsed=mailSearchRebuildInputSchema.safeParse(supplied);if(!parsed.success)throw new MailSearchError("invalid_input");const input=parsed.data;this.account(input.accountId);
    if(input.reset)this.db.run("INSERT OR IGNORE INTO mail_search_dirty SELECT account_id,message_key FROM mail_messages WHERE account_id=?",[input.accountId]);
    const rows=this.db.all("SELECT m.message_key,m.locator_json,m.subject FROM mail_search_dirty q JOIN mail_messages m ON m.account_id=q.account_id AND m.message_key=q.message_key WHERE q.account_id=? ORDER BY q.message_key LIMIT ?",[input.accountId,input.limit??10]);
    const projections=new MimeProjectionStore(this.db,this.ownerId),content=new MailContentStore(this.db,this.ownerId);
    for(const row of rows){
      const key=string.parse(row.message_key),locator=providerMessageLocatorSchema.parse(JSON.parse(string.parse(row.locator_json)));
      let subject=string.parse(row.subject),body='',names:string[]=[],senders:string[]=[],recipients:string[]=[],date:string|null=null,incomplete=1;let hasAttachment:number|null=null;
      try{
        const projection=projections.read(input.accountId,locator);
        if(projection && 'metadata' in projection){
          subject=projection.metadata.subject??subject;senders=addresses(projection.metadata.from);recipients=[...new Set([projection.metadata.to,projection.metadata.cc,projection.metadata.bcc].flatMap(addresses))];
          hasAttachment=projection.attachments.length>0?1:0;names=projection.attachments.flatMap(part=>part.filename===null||part.filename.length>512?[]:[part.filename]);date=projection.metadata.date;
          if(projection.body.bytes<=2*1024*1024){
            const bytes=Buffer.concat([...content.read(input.accountId,projection.body.id)]);
            const parsed=z.object({bodies:z.array(z.object({contentType:z.enum(['text/plain','text/html']),text:z.string()}))}).passthrough().parse(JSON.parse(bytes.toString('utf8')));
            body=parsed.bodies.map(part=>part.contentType==='text/plain'?part.text:htmlText(part.text)).join('\n');incomplete=projection.attachments.some(part=>part.filename!==null&&part.filename.length>512)?1:0;
          }
        }
      }catch{incomplete=1;body='';}
      const received=this.db.get('SELECT internal_date FROM mail_gmail_metadata WHERE account_id=? AND message_key=?',[input.accountId,key]);if(typeof received?.internal_date==='number'){const parsedDate=new Date(received.internal_date);if(Number.isFinite(parsedDate.getTime()))date=parsedDate.toISOString();else{date=null;incomplete=1;}}
      this.db.run('DELETE FROM mail_search_documents WHERE account_id=? AND message_key=?',[input.accountId,key]);
      if(locator.provider==='graph'){
        const direct=this.db.all(`SELECT a.metadata_json,a.error FROM mail_graph_attachments a JOIN mail_content_manifests m ON m.account_id=a.account_id AND m.message_key=a.message_key AND m.ref_id=a.raw_ref_id WHERE a.account_id=? AND a.message_key=? AND m.kind='raw' AND m.state='stored' LIMIT 101`,[input.accountId,key]);
        if(direct.length>100)throw new MailSearchError('invalid_input');
        for(const item of direct){if(typeof item.metadata_json!=='string')continue;const part=z.object({name:z.string()}).parse(JSON.parse(item.metadata_json));if(part.name.length<=512)names.push(part.name);else incomplete=1;if(item.error!==null)incomplete=1;}
        if(direct.length)hasAttachment=1;names=[...new Set(names)];
      }
      this.db.run('INSERT INTO mail_search_documents(account_id,message_key,subject,body,names,addresses,senders_json,recipients_json,filenames_json,date,incomplete,normalized_text,has_attachment) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[input.accountId,key,subject.normalize('NFC'),body.normalize('NFC'),names.join('\n').normalize('NFC'),[...senders,...recipients].join(' '),JSON.stringify(senders),JSON.stringify(recipients),JSON.stringify(names.map(normalize)),date,incomplete,normalize(subject+"\n"+body+"\n"+names.join("\n")),hasAttachment]);
      this.db.run('DELETE FROM mail_search_dirty WHERE account_id=? AND message_key=?',[input.accountId,key]);
    }
    return{processed:rows.length,...this.stats([input.accountId])};
  }));}
  search(supplied:MailSearchInput){return this.safe(()=>this.db.transaction(()=>{
    const parsed=mailSearchInputSchema.safeParse(supplied);if(!parsed.success)throw new MailSearchError('invalid_input');const input=parsed.data;
    const accounts=input.accountIds??this.db.all("SELECT a.id FROM mail_accounts a LEFT JOIN mail_account_credentials c ON c.account_id=a.id WHERE a.owner_id=? AND (c.state IS NULL OR c.state!='disconnected') ORDER BY a.id",[this.ownerId]).map(row=>string.parse(row.id));
    for(const account of accounts)this.account(account);
    if(!accounts.length)return{items:[],total:0,pending:0,incomplete:0,nextOffset:null};
    const where=[`d.account_id IN (${accounts.map(()=>'?').join(',')})`,'a.owner_id=?',"(c.state IS NULL OR c.state!='disconnected')",'NOT EXISTS(SELECT 1 FROM mail_search_dirty q WHERE q.account_id=d.account_id AND q.message_key=d.message_key)'];const params:MailSqlValue[]=[...accounts,this.ownerId];
    const terms=[...(input.keywords??[]).map(quote),...(input.phrase?[quote(input.phrase)]:[])];const match=terms.join(' AND ');
    if(match){where.push('mail_search_fts MATCH ?');params.push(match);}
    for(const [field,value] of [['senders_json',input.sender],['recipients_json',input.recipient],['filenames_json',input.filename]])if(value!==undefined){where.push(`EXISTS(SELECT 1 FROM json_each(d.${field}) WHERE value=?)`);params.push(normalize(value));}
    for(const value of [input.literal,input.matterIdentifier])if(value!==undefined){where.push("instr(d.normalized_text,?)>0");params.push(normalize(value));}
    if(input.afterDate){where.push('d.date>=?');params.push(new Date(input.afterDate).toISOString());}if(input.beforeDate){where.push('d.date<?');params.push(new Date(input.beforeDate).toISOString());}
    if(input.folderId){where.push('EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.account_id=d.account_id AND mm.message_key=d.message_key AND mm.folder_id=?)');params.push(input.folderId);}
    if(input.unread!==undefined){where.push(`((a.provider='gmail' AND ${input.unread?'':'NOT '}EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.account_id=d.account_id AND mm.message_key=d.message_key AND mm.folder_id='UNREAD')) OR (a.provider!='gmail' AND m.is_read=${input.unread?0:1}))`);}
    if(input.hasAttachment!==undefined){where.push(`d.has_attachment=${input.hasAttachment?1:0}`);}
    const from=`FROM mail_search_documents d JOIN mail_accounts a ON a.id=d.account_id LEFT JOIN mail_account_credentials c ON c.account_id=a.id JOIN mail_messages m ON m.account_id=d.account_id AND m.message_key=d.message_key ${match?'JOIN mail_search_fts ON mail_search_fts.rowid=d.id':''} WHERE ${where.join(' AND ')}`;
    const total=count.parse(this.db.get(`SELECT count(*) AS n ${from}`,params)?.n),limit=input.limit??20,offset=input.offset??0;
    const rows=this.db.all(`SELECT d.account_id,m.locator_json,d.subject,d.date,d.has_attachment,${match?"snippet(mail_search_fts,1,'','',' … ',32)":"substr(d.body,1,512)"} AS snippet ${from} ORDER BY d.date DESC,d.account_id,d.message_key LIMIT ? OFFSET ?`,[...params,limit,offset]);
    const result=mailSearchResultSchema.parse({items:rows.map(row=>({accountId:row.account_id,locator:JSON.parse(string.parse(row.locator_json)),subject:string.parse(row.subject).slice(0,512),snippet:string.parse(row.snippet).slice(0,512),date:row.date,hasAttachment:row.has_attachment===null?null:row.has_attachment===1})),total,...this.stats(accounts),nextOffset:offset+rows.length<total?offset+rows.length:null});
    while(Buffer.byteLength(JSON.stringify(result))>48*1024&&result.items.length>1)result.items.pop();
    result.nextOffset=offset+result.items.length<total?offset+result.items.length:null;return result;
  }));}
}
