import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import MailTools from '../opencode-plugins/legalwork-mail-tools.js';

test('every local task receives account tools; invocation binds trusted directory and never exposes engine credential',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mail-agent-plugin-'));
 const originalFetch=globalThis.fetch,previousToken=process.env.LEGALWORK_MAIL_AGENT_TOKEN,previousUrl=process.env.LEGALWORK_SERVER_URL;
 process.env.LEGALWORK_MAIL_AGENT_TOKEN='a'.repeat(64);process.env.LEGALWORK_SERVER_URL='http://127.0.0.1:9999';
 const calls:Array<{sessionId:string;directory:string;accountId?:string;request:unknown}>=[];
 globalThis.fetch=Object.assign(async(_input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+'a'.repeat(64));
  calls.push(JSON.parse(String(init?.body)));return Response.json({accounts:[{id:'account-a',displayName:'Personal'}]});
 },{preconnect:originalFetch.preconnect});
 try{
  const plugin=await MailTools({directory:root});
  expect(Object.keys(plugin.tool)).toContain('mail_send');expect(Object.keys(plugin.tool)).not.toContain('mail_scopes');
  for(const sessionID of ['first-chat','second-chat']){
   const result=await plugin.tool.mail_accounts.execute({},{sessionID,messageID:'message'});
   expect(result).toContain('account-a');expect(result).not.toContain('a'.repeat(64));
  }
  await plugin.tool.mail_read.execute({accountId:'account-a',request:'{"locator":{"provider":"gmail","messageId":"m"}}'},{sessionID:'second-chat',messageID:'message'});
  expect(calls.map(call=>call.sessionId)).toEqual(['first-chat','second-chat','second-chat']);
  expect(calls.every(call=>call.directory.endsWith(root.split('/').pop()!))).toBe(true);
  expect(calls[2]?.accountId).toBe('account-a');
  await expect(plugin.tool.mail_read.execute({accountId:'account-a',request:'{"tool":"propose_send"}'},{sessionID:'task',messageID:'message'})).rejects.toThrow();
  await expect(plugin.tool.mail_accounts.execute({},{})).rejects.toThrow();
  expect(calls).toHaveLength(3);
 }finally{
  globalThis.fetch=originalFetch;
  if(previousToken===undefined)delete process.env.LEGALWORK_MAIL_AGENT_TOKEN;else process.env.LEGALWORK_MAIL_AGENT_TOKEN=previousToken;
  if(previousUrl===undefined)delete process.env.LEGALWORK_SERVER_URL;else process.env.LEGALWORK_SERVER_URL=previousUrl;
  await rm(root,{recursive:true,force:true});
 }
});
