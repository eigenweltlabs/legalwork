import {expect,test} from 'bun:test';
import {MailListWindow} from '../src/react-app/domains/mail/mail-list-window';
test('incremental lists retain only four 250-row windows and preserve back/forward ordering',()=>{
 const pages=new MailListWindow<number>();pages.reset();
 for(let offset=0;offset<1250;offset+=25){pages.append(Array.from({length:25},(_,i)=>offset+i));expect(pages.rows.length).toBeLessThanOrEqual(250);}
 expect(pages.rows[0]).toBe(1000);expect(pages.back()[0]).toBe(750);expect(pages.back()[0]).toBe(500);expect(pages.back()[0]).toBe(250);expect(pages.canBack).toBe(false);expect(pages.forward()[0]).toBe(500);
 expect(()=>pages.append([1250])).toThrow();pages.forward();pages.forward();expect(pages.append([1250])[0]).toBe(1250);
 expect(pages.reset([1,2])).toEqual([1,2]);expect(pages.canForward).toBe(false);expect(pages.expanded).toBe(false);
});
