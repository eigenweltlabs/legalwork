import { resolve } from 'node:path';

/** The app's Vite middleware identifies its checkout; a generic Vite response does not. */
export async function matchesDevCheckout(url, expectedAppRoot, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(new URL('/__legalwork_dev_server_id', url), {
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    return false;
  }
  let identity;
  try { identity = await response.json(); } catch { /* Non-LegalWork servers have no identity. */ }
  if (response.ok && typeof identity?.appRoot === 'string' && resolve(identity.appRoot) === resolve(expectedAppRoot)) {
    return true;
  }
  const actual = typeof identity?.appRoot === 'string' ? identity.appRoot : 'an unidentified server';
  throw new Error(`Development URL ${url} belongs to ${actual}, not ${expectedAppRoot}. Choose a free PORT or deliberately set LEGALWORK_ELECTRON_START_URL.`);
}
