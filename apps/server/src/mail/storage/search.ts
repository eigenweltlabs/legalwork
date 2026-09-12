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
  constructor(private readonly db:MailDatabase,private readonly ownerId:string,private readonly trusted:{offlineMaintenance?:boolean}={}){}
  private account(accountId:string){
    const row=this.db.get("SELECT a.provider,coalesce(c.state,i.state) AS state FROM mail_accounts a LEFT JOIN mail_account_access c ON c.account_id=a.id LEFT JOIN mail_imap_credentials i ON i.account_id=a.id WHERE a.id=? AND a.owner_id=?",[accountId,this.ownerId]);
    if(!row)throw new MailSearchError("not_found");if(row.state==='disconnected'&&!this.trusted.offlineMaintenance)throw new MailSearchError("locked");return row;
  }
  private safe<T>(fn:()=>T):T{try{return fn();}catch(error){if(error instanceof MailSearchError)throw error;throw new MailSearchError("unavailable");}}
  private filingPredicate(alias:string,filingIds:string[]){return `EXISTS(SELECT 1 FROM mail_matter_filings ff JOIN mail_filing_snapshots fs ON fs.id=ff.snapshot_id WHERE ff.state='filed' AND ff.id IN (SELECT value FROM json_each(?)) AND fs.account_id=${alias}.account_id AND fs.source_message_key=${alias}.message_key)`;}
  private stats(accounts:string[],scope?:{filingIds:string[]}){const marks=accounts.map(()=>'?').join(',');if(!accounts.length)return{pending:0,incomplete:0};return{
    pending:count.parse(this.db.get(`SELECT count(*) AS n FROM mail_search_dirty d WHERE account_id IN (${marks}) ${scope?'AND '+this.filingPredicate('d',scope.filingIds):''}`,[...accounts,...(scope?[JSON.stringify(scope.filingIds)]:[])])?.n),
    incomplete:count.parse(this.db.get(`SELECT count(*) AS n FROM mail_search_documents d WHERE account_id IN (${marks}) AND incomplete=1 AND NOT EXISTS(SELECT 1 FROM mail_search_dirty q WHERE q.account_id=d.account_id AND q.message_key=d.message_key) ${scope?'AND '+this.filingPredicate('d',scope.filingIds):''}`,[...accounts,...(scope?[JSON.stringify(scope.filingIds)]:[])])?.n),
  };}
  /** Background turns do not recount the entire mailbox after every document. */
  indexNext(accountId:string){return this.processBatch({accountId,limit:1});}
  rebuild(supplied:MailSearchRebuildInput){return this.safe(()=>this.db.transaction(()=>({processed:this.processBatch(supplied),...this.stats([supplied.accountId])})));}
  private processBatch(supplied:MailSearchRebuildInput){return this.safe(()=>this.db.transaction(()=>{
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
      const extractionRows=this.db.all(`SELECT e.state,e.result_json FROM mail_attachment_extractions e JOIN mail_content_manifests m ON m.account_id=e.account_id AND m.message_key=e.message_key AND m.part_id=e.part_id AND m.ref_id=e.ref_id AND m.kind='attachment' AND m.state='stored' WHERE e.account_id=? AND e.message_key=? AND e.extractor='local-text-v1' ORDER BY e.part_id LIMIT 9`,[input.accountId,key]);
      if(extractionRows.length>8)incomplete=1;
      for(const extracted of extractionRows.slice(0,8)){if(extracted.state!=='complete'){incomplete=1;continue;}try{const result=z.object({sections:z.array(z.object({text:z.string()}))}).parse(JSON.parse(string.parse(extracted.result_json)));body+='\n'+result.sections.map(section=>section.text).join('\n');}catch{incomplete=1;}}
      this.db.run('INSERT INTO mail_search_documents(account_id,message_key,subject,body,names,addresses,senders_json,recipients_json,filenames_json,date,incomplete,normalized_text,has_attachment) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[input.accountId,key,subject.normalize('NFC'),body.normalize('NFC'),names.join('\n').normalize('NFC'),[...senders,...recipients].join(' '),JSON.stringify(senders),JSON.stringify(recipients),JSON.stringify(names.map(normalize)),date,incomplete,normalize(subject+"\n"+body+"\n"+names.join("\n")),hasAttachment]);
      this.db.run('DELETE FROM mail_search_dirty WHERE account_id=? AND message_key=?',[input.accountId,key]);
    }
    return rows.length;
  }));}
  private attachmentMatches(accountId:string,messageKey:string,input:MailSearchInput){
    const terms=[input.literal,input.matterIdentifier,input.phrase,...(input.keywords??[])].filter((value):value is string=>typeof value==='string');
    if(!terms.length)return [];
    const rows=this.db.all(`SELECT e.part_id,e.ref_id,e.state,e.result_json FROM mail_attachment_extractions e JOIN mail_content_manifests m ON m.account_id=e.account_id AND m.message_key=e.message_key AND m.kind='attachment' AND m.part_id=e.part_id AND m.ref_id=e.ref_id AND m.state='stored' WHERE e.account_id=? AND e.message_key=? AND e.extractor='local-text-v1' ORDER BY e.part_id LIMIT 8`,[accountId,messageKey]);
    const matches=[];
    for(const row of rows){if(row.state!=='complete')continue;const value=z.object({sections:z.array(z.object({source:z.string(),text:z.string()}))}).safeParse(JSON.parse(string.parse(row.result_json)));if(!value.success)continue;
      for(const [section,part] of value.data.sections.entries()){
        const plain=normalize(part.text);let at=-1;
        for(const term of terms){const exact=plain.indexOf(normalize(term));if(exact>=0){at=exact;break;}}
        // Token phrase navigation also handles punctuation between consecutive FTS words.
        if(at<0){const tokens=[...plain.matchAll(/[\p{L}\p{N}\p{M}\p{Co}]+/gu)];for(const term of [input.phrase,...(input.keywords??[])]){if(!term)continue;const words=normalize(term).match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu)??[];if(!words.length)continue;for(let start=0;start<tokens.length;start++)if(words.every((word,index)=>tokens[start+index]?.[0]===word)){at=tokens[start].index;break;}if(at>=0)break;}}
        if(at>=0){matches.push({partId:string.parse(row.part_id),referenceId:string.parse(row.ref_id),section,offset:Math.max(0,Math.min(part.text.length,at)-80),source:part.source});break;}
      }
    }return matches;
  }
  search(supplied:MailSearchInput,scope?:{filingIds:string[]}){return this.safe(()=>this.db.transaction(()=>{
    const parsed=mailSearchInputSchema.safeParse(supplied);if(!parsed.success)throw new MailSearchError('invalid_input');const input=parsed.data;
    const accounts=input.accountIds??this.db.all("SELECT a.id FROM mail_accounts a LEFT JOIN mail_account_access c ON c.account_id=a.id LEFT JOIN mail_imap_credentials i ON i.account_id=a.id WHERE a.owner_id=? AND (coalesce(c.state,i.state) IS NULL OR coalesce(c.state,i.state)!='disconnected') ORDER BY a.id",[this.ownerId]).map(row=>string.parse(row.id));
    for(const account of accounts)this.account(account);
    if(!accounts.length)return{items:[],total:0,pending:0,incomplete:0,nextOffset:null};
    // Account access was checked above inside this same synchronous transaction.
    // Avoid repeating credential-view joins for every matching document.
    const where=[`d.account_id IN (${accounts.map(()=>'?').join(',')})`,'NOT EXISTS(SELECT 1 FROM mail_search_dirty q WHERE q.account_id=d.account_id AND q.message_key=d.message_key)'];const params:MailSqlValue[]=[...accounts];
    if(scope){where.push(this.filingPredicate('d',scope.filingIds));params.push(JSON.stringify(scope.filingIds));}
    const terms=[...(input.keywords??[]).map(quote),...(input.phrase?[quote(input.phrase)]:[])];
    for(const [column,value] of [['addresses',input.sender],['addresses',input.recipient]])if(value!==undefined&&/[a-z0-9]/i.test(value))terms.push(column+' : '+quote(normalize(value)));
    const match=terms.join(' AND ');
    if(match){where.push('mail_search_fts MATCH ?');params.push(match);}
    for(const [field,value] of [['senders_json',input.sender],['recipients_json',input.recipient],['filenames_json',input.filename]])if(value!==undefined){where.push(`EXISTS(SELECT 1 FROM json_each(d.${field}) WHERE value=?)`);params.push(normalize(value));}
    for(const value of [input.literal,input.matterIdentifier,input.filename])if(value!==undefined){
      const normalized=normalize(value);
      // GLOB's escaped metacharacters retain arbitrary substring semantics. FTS5
      // uses compact trigrams when possible and safely scans for shorter literals.
      // SQLite GLOB stops at NUL; retain those rare documents as exact-check candidates.
      where.push("d.id IN (SELECT rowid FROM mail_search_trigram WHERE normalized_text GLOB ? UNION SELECT id FROM mail_search_documents WHERE instr(normalized_text,char(0))>0)");params.push('*'+normalized.replace(/[?*\[]/g,char=>char==='['?'[[]':'['+char+']')+'*');
      where.push("instr(d.normalized_text,?)>0");params.push(normalized);
    }
    if(input.afterDate){where.push('d.date>=?');params.push(new Date(input.afterDate).toISOString());}if(input.beforeDate){where.push('d.date<?');params.push(new Date(input.beforeDate).toISOString());}
    if(input.folderId){where.push('EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.account_id=d.account_id AND mm.message_key=d.message_key AND mm.folder_id=?)');params.push(input.folderId);}
    if(input.unread!==undefined){where.push(`((a.provider='gmail' AND ${input.unread?'':'NOT '}EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.account_id=d.account_id AND mm.message_key=d.message_key AND mm.folder_id='UNREAD')) OR (a.provider!='gmail' AND m.is_read=${input.unread?0:1}))`);}
    if(input.hasAttachment!==undefined){where.push(`d.has_attachment=${input.hasAttachment?1:0}`);}
    const coveringMatch=match&&!input.sender&&!input.recipient&&!input.filename&&!input.literal&&!input.matterIdentifier;
    const from=`FROM mail_search_documents d ${coveringMatch?'INDEXED BY mail_search_identity':!match&&(input.afterDate||input.beforeDate)?'INDEXED BY mail_search_date':''} ${input.unread!==undefined?'JOIN mail_accounts a ON a.id=d.account_id JOIN mail_messages m ON m.account_id=d.account_id AND m.message_key=d.message_key':''} ${match?'JOIN mail_search_fts ON mail_search_fts.rowid=d.id':''} WHERE ${where.join(' AND ')}`;
    const total=count.parse(this.db.get(`SELECT count(*) AS n ${from}`,params)?.n),limit=input.limit??20,offset=input.offset??0;
    const literalSnippet=input.literal??input.matterIdentifier;
    const columns="d.account_id,d.message_key,m.locator_json,d.subject,d.date,d.has_attachment";
    // Materialize only the page identities before building FTS snippets. A broad
    // match must not tokenize every matching body while sorting for twenty rows.
    const snippet=match?"snippet(mail_search_fts,1,'','',' … ',32)":literalSnippet?"substr(d.normalized_text,max(1,instr(d.normalized_text,?)-80),320)":"substr(d.body,1,512)";
    const rows=this.db.all(`WITH page AS MATERIALIZED (SELECT d.id ${from} ORDER BY d.date DESC,d.account_id,d.message_key LIMIT ? OFFSET ?)
      SELECT ${columns},${snippet} AS snippet
      FROM page CROSS JOIN mail_search_documents d ON d.id=page.id CROSS JOIN mail_messages m ON m.account_id=d.account_id AND m.message_key=d.message_key
      ${match?'CROSS JOIN mail_search_fts ON mail_search_fts.rowid=d.id WHERE mail_search_fts MATCH ?':''} ORDER BY d.date DESC,d.account_id,d.message_key`,[...params,limit,offset,...(!match&&literalSnippet?[normalize(literalSnippet)]:[]),...(match?[match]:[])]);
    const result=mailSearchResultSchema.parse({items:rows.map(row=>({accountId:row.account_id,locator:JSON.parse(string.parse(row.locator_json)),subject:string.parse(row.subject).slice(0,512),snippet:string.parse(row.snippet).slice(0,512),date:row.date,hasAttachment:row.has_attachment===null?null:row.has_attachment===1,attachmentMatches:this.attachmentMatches(string.parse(row.account_id),string.parse(row.message_key),input),attachmentSources:this.db.all(`SELECT e.part_id,e.ref_id,e.state FROM mail_attachment_extractions e JOIN mail_content_manifests m ON m.account_id=e.account_id AND m.message_key=e.message_key AND m.kind='attachment' AND m.part_id=e.part_id AND m.ref_id=e.ref_id AND m.state='stored' WHERE e.account_id=? AND e.message_key=? AND e.extractor='local-text-v1' ORDER BY e.part_id LIMIT 8`,[string.parse(row.account_id),string.parse(row.message_key)]).filter(source=>source.state==='complete').map(source=>({partId:source.part_id,referenceId:source.ref_id}))})),total,...this.stats(accounts,scope),nextOffset:offset+rows.length<total?offset+rows.length:null});
    while(Buffer.byteLength(JSON.stringify(result))>48*1024&&result.items.length>1)result.items.pop();
    result.nextOffset=offset+result.items.length<total?offset+result.items.length:null;return result;
  }));}
}
