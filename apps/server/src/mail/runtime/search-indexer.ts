import type { MailDatabase } from "../storage/database-interface.js";
import { MailSearchStore } from "../storage/search.js";
/** One message per event-loop turn; rotate accounts instead of draining a busy mailbox. */
export class MailSearchIndexer {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private closed=false;
  private after="";
  private readonly search:MailSearchStore;
  constructor(private readonly database:MailDatabase,private readonly ownerId:string){this.search=new MailSearchStore(database,ownerId);}
  start():void{if(!this.closed&&!this.timer)this.schedule(0);}
  close():void{this.closed=true;clearTimeout(this.timer);this.timer=undefined;}
  private schedule(delay:number):void{this.timer=setTimeout(()=>this.tick(),delay);this.timer.unref();}
  private tick():void{
    this.timer=undefined;if(this.closed)return;let busy=false;
    try{
      const select=(after:string)=>this.database.get(`SELECT a.id FROM mail_accounts a WHERE a.owner_id=? AND a.id>?
        AND NOT EXISTS(SELECT 1 FROM mail_account_credentials c WHERE c.account_id=a.id AND c.state='disconnected')
        AND EXISTS(SELECT 1 FROM mail_search_dirty d WHERE d.account_id=a.id) ORDER BY a.id LIMIT 1`,[this.ownerId,after]);
      const row=select(this.after)??select("");
      if(row&&typeof row.id==='string'){this.after=row.id;this.search.rebuild({accountId:row.id,limit:1});busy=true;}
    }catch{/* Keep failures private; leave durable work queued and try another account. */}
    if(!this.closed)this.schedule(busy?25:1000);
  }
}
