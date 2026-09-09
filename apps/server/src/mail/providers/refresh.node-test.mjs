/** Actual Node tests, synthetic credentials, injected HTTP only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshMailOAuth, MailRefreshError } from './refresh.js';
import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from '../provider-config.js';
const gmail={provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-secret',scopes:GMAIL_MAIL_SCOPES};
const graph={provider:'graph',applicationType:'desktop',pkceMethod:'S256',clientId:'11111111-2222-3333-4444-555555555555',tenantId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',registeredRedirectUri:'http://localhost/mail/callback',scopes:GRAPH_MAIL_SCOPES};
const success={access_token:'synthetic-access',token_type:'Bearer',expires_in:3600};
test('Google preserves omitted refresh token and sends credentials only in form body',async()=>{
 const result=await refreshMailOAuth({settings:gmail,refreshToken:'synthetic-old',fetch:async(url,options)=>{
  assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');
  const body=new URLSearchParams(options.body);assert.equal(body.get('refresh_token'),'synthetic-old');assert.equal(body.get('client_secret'),'synthetic-secret');assert.equal(body.has('scope'),false);
  return Response.json(success);
 }});assert.deepEqual(result.refreshToken,{action:'preserve'});assert.equal(result.grantedScopes,null);
});
test('Graph exposes replacement without mutating original credential',async()=>{
 const input={settings:graph,refreshToken:'synthetic-old',fetch:async(url,options)=>{
  assert.equal(url,`https://login.microsoftonline.com/${graph.tenantId}/oauth2/v2.0/token`);assert.equal(new URLSearchParams(options.body).has('client_secret'),false);
  return Response.json({...success,refresh_token:'synthetic-new'});
 }};const result=await refreshMailOAuth(input);assert.deepEqual(result.refreshToken,{action:'replace',value:'synthetic-new'});assert.equal(input.refreshToken,'synthetic-old');
});
test('Node timeout and reconsent errors remain redacted',async()=>{
 await assert.rejects(refreshMailOAuth({settings:gmail,refreshToken:'synthetic-old',timeoutMs:10,fetch:async()=>new Promise(()=>{})}),error=>error instanceof MailRefreshError&&error.code==='timeout');
 await assert.rejects(refreshMailOAuth({settings:gmail,refreshToken:'synthetic-old',fetch:async()=>Response.json({error:'invalid_grant',error_description:'synthetic-secret'},{status:400})}),error=>error instanceof MailRefreshError&&error.code==='reconsent_required'&&!JSON.stringify(error).includes('synthetic-secret'));
});
