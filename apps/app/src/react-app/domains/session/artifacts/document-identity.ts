/** Local workspace identity comes from workspace routing, never the URL's host.
 * Ownership and recovery must use the same key, including through local aliases.
 * Remote workers retain their endpoint namespace, even through SSH tunnels. */
export function documentIdentityKey(baseUrl: string, fileId: string, isLocalWorkspace: boolean) {
  return JSON.stringify([isLocalWorkspace ? "local-file" : baseUrl, fileId]);
}
