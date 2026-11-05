/** Test-only relays consume Fetch-decoded bytes. Do not forward wire encoding or
 * hop framing headers as though those decoded bytes were still compressed. */
export function nativeDecodedRelayResponse(response: Response, bytes: Uint8Array) {
  const headers = new Headers(response.headers);
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]) headers.delete(name);
  return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(bytes), { status: response.status, headers });
}
