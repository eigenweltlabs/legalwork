import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ServerConfig } from '../types.js';
import { ApiError } from '../errors.js';
import { parseNative } from './native.js';
import { localOAuthCalendarAccess } from './local-oauth.js';

export type CalendarAccessGuard = (owner: string, token: string, writing: boolean, signal?: AbortSignal) => Promise<boolean>;

/** Ownership is checked using the actual dispatch credential, including refreshed
 * tokens. A cached owner from an earlier token must not turn a shared calendar
 * into a personal one. Broker apps retain their fixed provider-grant behavior. */
export function calendarAccessGuard(config: ServerConfig, id: string, connectionId: string, local: boolean): CalendarAccessGuard {
  const profiles = new Map<string, Promise<Set<string> | null>>();
  const email = z.email().max(320);
  const schema = z.object({ id: z.string().min(1).max(4096), mail: z.string().nullish(), userPrincipalName: z.string().nullish() });
  return async (owner, token, writing, signal) => {
    if (id !== 'outlook-calendar' || !email.safeParse(owner).success) throw new ApiError(400, 'connector_invalid_endpoint', 'Invalid calendar owner.');
    if (!local) return true;
    const key = createHash('sha256').update(token).digest('hex');
    let pending = profiles.get(key);
    if (!pending) {
      if (profiles.size >= 32) profiles.clear();
      pending = (async () => {
        let response: Response;
        try {
          response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
        } catch { throw new ApiError(502, 'connector_api_unreachable', 'Could not verify the calendar account.'); }
        if (response.status === 401) { await response.body?.cancel(); return null; }
        if (!response.ok) { await response.body?.cancel(); throw new ApiError(502, 'connector_api_unreachable', 'Could not verify the calendar account.'); }
        let value: unknown;
        try { value = await response.json(); }
        catch { throw new ApiError(502, 'connector_api_invalid', 'The provider returned an invalid account.'); }
        const profile = parseNative(schema, value);
        const addresses = new Set([profile.mail, profile.userPrincipalName].flatMap(value => { const parsed = email.safeParse(value); return parsed.success ? [parsed.data.toLowerCase()] : []; }));
        if (!addresses.size) throw new ApiError(502, 'connector_api_invalid', 'The provider returned an invalid account.');
        return addresses;
      })();
      profiles.set(key, pending);
      void pending.then(value => { if (!value) profiles.delete(key); }, () => profiles.delete(key));
    }
    const personal = await pending;
    if (!personal) return false;
    if (personal.has(owner.toLowerCase())) return true;
    const access = await localOAuthCalendarAccess(config, id, connectionId);
    if (writing ? !access.write : !access.read) throw new ApiError(403, 'connector_calendar_permission_required', 'Shared calendar permission required.');
    return true;
  };
}
