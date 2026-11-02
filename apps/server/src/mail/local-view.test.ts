import {test,expect} from 'bun:test';
import {mailLocalCommandSchema,mailLocalResultSchema,localResultMatches} from './local-view.js';
const id='11111111-1111-4111-8111-111111111111',version={generation:id,revision:1};
test('local results correlate historical revision and reject payload/event shape escapes',()=>{
 const command=mailLocalCommandSchema.parse({operation:'mail.local.draft.read',accountId:'a',input:{draftId:id,version}});
 const result=mailLocalResultSchema.parse({operation:command.operation,accountId:'a',value:{id,version,updatedAt:1,deleted:false,subject:'s',content:{subject:'s',to:[],text:''}}});
 if(result.operation!=='mail.local.draft.read')throw Error('unexpected result');
 expect(localResultMatches(command,result)).toBe(true);
 expect(localResultMatches(command,{...result,value:{...result.value,version:{...version,revision:2}}})).toBe(false);
 expect(localResultMatches(command,{...result,accountId:'foreign'})).toBe(false);
 expect(mailLocalResultSchema.safeParse({...result,value:{...result.value,accessToken:'private'}}).success).toBe(false);
 expect(mailLocalCommandSchema.safeParse({operation:'mail.local.events',accountId:'a',input:{after:1}}).success).toBe(false);
 expect(mailLocalResultSchema.safeParse({operation:'mail.local.events',accountId:'a',value:{accountId:'a',stream:'a'.repeat(32),resetRequired:false,items:[{sequence:1,kind:'draft.saved',entityId:id,state:['active'],version}],nextCursor:1,hasMore:false}}).success).toBe(false);
});
