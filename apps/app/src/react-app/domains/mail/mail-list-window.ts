/** A bounded browsing history. Provider cursors remain in UnifiedMailPages. */
export class MailListWindow<T> {
  private windows:Array<{rows:T[];scroll:number}>=[];
  private index=0;
  readonly limit=250;
  get rows():T[]{return this.windows[this.index]?.rows??[];}
  get scroll(){return this.windows[this.index]?.scroll??0;}
  set scroll(value:number){const window=this.windows[this.index];if(window)window.scroll=Math.max(0,value);}
  get retained(){return this.windows.flatMap(window=>window.rows);}
  get canBack(){return this.index>0;}
  get canForward(){return this.index<this.windows.length-1;}
  get expanded(){return this.windows.length>1||this.rows.length>25;}
  reset(rows:T[]=[]){this.windows=[{rows,scroll:0}];this.index=0;return this.rows;}
  append(rows:T[]){
    if(this.canForward)throw Error('Advance to the newest loaded window before loading more.');
    if(this.rows.length+rows.length>this.limit){this.windows.push({rows,scroll:0});this.index++;if(this.windows.length>4){this.windows.shift();this.index--;}}
    else this.windows[this.index]={rows:[...this.rows,...rows],scroll:this.scroll};
    return this.rows;
  }
  back(){if(this.canBack)this.index--;return this.rows;}
  forward(){if(this.canForward)this.index++;return this.rows;}
}
