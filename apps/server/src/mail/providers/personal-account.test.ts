import { test, expect } from 'bun:test';
import { GRAPH_MAIL_SCOPES, checkMailProviderReadiness } from '../provider-config.js';
import { discoverMailIdentity } from './identity.js';
import { refreshMailOAuth } from './refresh.js';
import { parseGraphMailRegistration } from './development-config.js';
const settings = parseGraphMailRegistration({clientId:'f7ae407e-0e9f-442d-a7e5-60cf8740992a',tenantId:'consumers'});
test('personal authority uses authenticated opaque Graph identity without organization or JWT/UPN fallback', async()=>{
 const urls:string[]=[];
 const result=await discoverMailIdentity({settings,accessToken:'synthetic',grantedScopes:GRAPH_MAIL_SCOPES,fetch:async url=>{urls.push(url);return Response.json({id:'A1B2C3D4E5F6',mail:'demo@outlook.com',displayName:'Demo',userPrincipalName:'not-identity'});}});
 expect(urls).toEqual(['https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName']);
 expect(result.authority).toBe('https://login.microsoftonline.com/consumers/v2.0');expect(result.providerSubject).toBe('A1B2C3D4E5F6');
 for(const data of [{id:'A1',mail:null,userPrincipalName:'demo@outlook.com'},{id:'demo@outlook.com',mail:'demo@outlook.com'}])await expect(discoverMailIdentity({settings,accessToken:'synthetic',grantedScopes:GRAPH_MAIL_SCOPES,fetch:async()=>Response.json(data)})).rejects.toThrow('response_invalid');
});
test('personal refresh stays at consumers endpoint and rejects unverified grants',async()=>{
 const result=await refreshMailOAuth({settings,refreshToken:'synthetic',fetch:async(url,init)=>{expect(url).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/token');expect(init.redirect).toBe('error');return Response.json({access_token:'new',token_type:'Bearer',expires_in:3600,scope:'User.Read Mail.ReadWrite Mail.Send',refresh_token:'rotated'});}});
 expect(result.refreshToken).toEqual({action:'replace',value:'rotated'});
 await expect(discoverMailIdentity({settings,accessToken:'synthetic',grantedScopes:null,fetch:async()=>{throw Error('must not fetch');}})).rejects.toThrow('scope_unverified');
 for(const tenantId of ['common','organizations','evil.test','consumers/../common'])expect(checkMailProviderReadiness({...settings,tenantId,redirectUri:'http://localhost:12345/mail/callback'}).configurationReady).toBe(false);
});
