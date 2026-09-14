import { z } from 'zod';
import { MailClient } from './mail-client';
const id = z.string().min(1).max(4096);
const started = z.object({ connectionId: id, authorizationUrl: z.string().max(16384), expiresAt: z.number() });
const status = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['pending', 'verifying', 'cancelled', 'expired']), connectionId: id, expiresAt: z.number() }),
  z.object({ state: z.literal('connected'), connectionId: id, expiresAt: z.number(), accountId: id, renewable: z.boolean() }),
  z.object({ state: z.literal('failed'), connectionId: id, expiresAt: z.number(), error: z.string() }),
]);
export type AccountChoice = 'gmail' | 'outlook' | 'microsoft-work' | 'icloud' | 'manual';
export type ImapInput = { host: string; port: number; username: string; password: string; folders?: string[]; reconnectAccountId?: string };
export function authorizationUrl(value: string, choice: AccountChoice): string {
  if (!/^https:\/\//.test(value) || /[\\\s]/.test(value)) throw Error('The sign-in address is invalid.');
  const url = new URL(value);
  const expected = choice === 'gmail' ? url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth'
    : url.origin === 'https://login.microsoftonline.com' && /^\/(consumers|[0-9a-f-]{36})\/oauth2\/v2\.0\/authorize$/.test(url.pathname)
      && (choice === 'outlook' ? url.pathname.startsWith('/consumers/') : !url.pathname.startsWith('/consumers/'));
  if (!expected || url.username || url.password || url.hash || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256') throw Error('The sign-in address is invalid.');
  return value;
}
export class MailOnboardingClient {
  constructor(private client: MailClient) {}
  begin(choice: AccountChoice, signal: AbortSignal, reconnectAccountId?: string) {
    signal.throwIfAborted();
    return this.client.request('/connections', started, AbortSignal.timeout(15000), { provider: choice === 'gmail' ? 'gmail' : 'graph', ...(choice === 'gmail' ? {} : { personal: choice === 'outlook' }), ...(reconnectAccountId ? { reconnectAccountId } : {}) });
  }
  status(connectionId: string, signal: AbortSignal) { return this.client.request('/connections/' + encodeURIComponent(connectionId), status, signal); }
  cancel(connectionId: string) { return this.client.request('/connections/' + encodeURIComponent(connectionId) + '/cancel', z.object({ cancelled: z.boolean() }), AbortSignal.timeout(5000), undefined, true); }
  disconnect(accountId: string, signal: AbortSignal) { return this.client.request('/accounts/' + encodeURIComponent(accountId) + '/disconnect', z.object({ disconnected: z.boolean() }), signal, undefined, true); }
  cancelImap(requestId:string) {return this.client.request(`/imap/connections/${encodeURIComponent(requestId)}/cancel`,z.object({cancelled:z.boolean()}),AbortSignal.timeout(5000),undefined,true);}
  imap(input: ImapInput, signal: AbortSignal, requestId:string) {
    return this.client.request('/imap/connections', z.union([z.object({ accountId: id, provider: z.literal('imap') }), z.object({ error: z.string() })]), signal, {...input,requestId}, false, 35000);
  }
  discovery(accountId: string, signal: AbortSignal) {
    return this.client.request('/accounts/' + encodeURIComponent(accountId) + '/imap', z.object({ settings: z.object({ host: z.string(), port: z.number(), username: z.string(), folders: z.array(z.string()).optional() }) }), signal);
  }
}
