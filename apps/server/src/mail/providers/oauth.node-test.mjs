/** Actual Node loopback smoke tests. All provider exchanges are injected mocks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMailOAuth } from './oauth.js';
import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from '../provider-config.js';
const gmail={provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-secret',scopes:GMAIL_MAIL_SCOPES};
const graph={provider:'graph',applicationType:'desktop',pkceMethod:'S256',clientId:'11111111-2222-3333-4444-555555555555',tenantId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',registeredRedirectUri:'http://localhost/mail/callback',scopes:GRAPH_MAIL_SCOPES};
for (const settings of [gmail,graph]) test(`actual Node ${settings.provider} callback with normal system hostname resolution`,async()=>{
  let calls=0;
  const flow=await startMailOAuth(settings,{fetch:async()=>{
    calls++;return Response.json({access_token:'synthetic-access',token_type:'Bearer',expires_in:3600});
  }});
  try {
    const callback=new URL(flow.redirectUri);
    callback.searchParams.set('state',new URL(flow.authorizationUrl).searchParams.get('state'));
    callback.searchParams.set('code','synthetic-code');
    const page=await fetch(callback);
    assert.equal(page.status,200);
    assert.ok(!(await page.text()).includes('synthetic-code'));
    const token=await flow.result;
    assert.equal(token.accessToken,'synthetic-access');assert.equal(token.grantedScopes,null);assert.equal(calls,1);
  } finally {await flow.cancel();}
});
test('actual Node cancel closes both listeners without provider HTTP',async()=>{
  const flow=await startMailOAuth(graph,{fetch:async()=>{throw new Error('unexpected provider HTTP');}});
  const rejected=assert.rejects(flow.result,/cancelled/);
  await flow.cancel();await rejected;
  await assert.rejects(fetch(flow.redirectUri));
});
