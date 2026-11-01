import { z } from 'zod';

// MAIL-160 protocol experiment. Injected transport only; no production registration or credentials.
export const JMAP_CORE = 'urn:ietf:params:jmap:core';
export const JMAP_MAIL = 'urn:ietf:params:jmap:mail';
export const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';
const origin = 'https://api.fastmail.com';
const id = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
const state = z.string().min(1).max(4096);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const set = z.record(id, z.literal(true));
const email = z.object({ id, blobId: id, threadId: id, mailboxIds: set.refine(value => Object.keys(value).length > 0),
  keywords: z.record(z.string().min(1).max(255), z.literal(true)), size: count });
const account = z.object({ isReadOnly: z.boolean(), accountCapabilities: z.record(z.string(), z.object({}).passthrough()) });
const session = z.object({ apiUrl: z.string().url(), downloadUrl: z.string(),
  capabilities: z.record(z.string(), z.object({}).passthrough()), accounts: z.record(id, account) });
const response = z.object({ methodResponses: z.array(z.tuple([z.string(), z.unknown(), z.string()])).length(1) });

export class JmapProbeError extends Error {
  constructor(code) { super('jmap_probe_' + code); this.code = code; }
}
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new JmapProbeError('invalid_response');
  return result.data;
}
function trustedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new JmapProbeError('endpoint'); }
  if (url.origin !== origin || url.username || url.password || url.hash) throw new JmapProbeError('endpoint');
  return url.href;
}

export class JmapContractProbe {
  #session;
  #sequence = 0;
  constructor({ fetch, accountId }) {
    if (typeof fetch !== 'function') throw new JmapProbeError('transport_required');
    this.fetch = fetch;
    this.accountId = id.parse(accountId);
    this.metrics = { requests: 0, responseBytes: 0, largestResponseBytes: 0 };
  }
  async #request(url, body, binary = false) {
    const target = trustedUrl(url);
    this.metrics.requests++;
    const received = await this.fetch(target, { method: body ? 'POST' : 'GET',
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000),
      headers: { Accept: binary ? 'message/rfc822' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!received.ok || received.redirected || !received.body) {
      await received.body?.cancel();
      throw new JmapProbeError('transport');
    }
    const reader = received.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > (binary ? 1024 * 1024 : 256 * 1024) || chunks.length >= 10000) throw new JmapProbeError('response_limit');
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    this.metrics.responseBytes += bytes;
    this.metrics.largestResponseBytes = Math.max(this.metrics.largestResponseBytes, bytes);
    const buffer = Buffer.concat(chunks);
    if (binary) return buffer;
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
    catch { throw new JmapProbeError('invalid_response'); }
  }
  async connect() {
    this.#session = undefined;
    const value = parse(session, await this.#request(origin + '/jmap/session'));
    const selected = value.accounts[this.accountId];
    if (!selected?.accountCapabilities[JMAP_MAIL] || !value.capabilities[JMAP_CORE] || !value.capabilities[JMAP_MAIL]) throw new JmapProbeError('capability');
    trustedUrl(value.apiUrl);
    // The experiment allows only one origin. A live adapter must review CDN/download origins separately.
    trustedUrl(value.downloadUrl.replaceAll('{accountId}', 'a').replaceAll('{blobId}', 'b').replaceAll('{name}', 'message.eml').replaceAll('{type}', 'message%2Frfc822'));
    const limits = parse(z.object({ maxObjectsInGet: z.number().int().positive() }), value.capabilities[JMAP_CORE]);
    this.#session = value;
    this.batchSize = Math.min(limits.maxObjectsInGet, 100);
    return { readOnly: selected.isReadOnly, submission: Boolean(selected.accountCapabilities[JMAP_SUBMISSION] && value.capabilities[JMAP_SUBMISSION]) };
  }
  async #call(method, arguments_) {
    if (!this.#session) throw new JmapProbeError('not_connected');
    const tag = String(++this.#sequence);
    const value = parse(response, await this.#request(this.#session.apiUrl, { using: [JMAP_CORE, JMAP_MAIL],
      methodCalls: [[method, { accountId: this.accountId, ...arguments_ }, tag]] }));
    const [name, data, returnedTag] = value.methodResponses[0];
    if (returnedTag !== tag) throw new JmapProbeError('response_tag');
    if (name === 'error') {
      const error = parse(z.object({ type: z.string() }), data);
      if (error.type === 'cannotCalculateChanges') throw new JmapProbeError('reset_required');
      if (error.type === 'stateMismatch') throw new JmapProbeError('conflict');
      throw new JmapProbeError('method_error');
    }
    if (name !== method || parse(z.object({ accountId: id }), data).accountId !== this.accountId) throw new JmapProbeError('response_account');
    return data;
  }
  async baseline() {
    if (!this.#session) throw new JmapProbeError('not_connected');
    const records = [], seen = new Set();
    let queryState, emailState;
    for (let page = 0; page < 10; page++) {
      const queried = parse(z.object({ accountId: id, queryState: state, position: count, ids: z.array(id).max(this.batchSize), total: count }),
        await this.#call('Email/query', { position: records.length, limit: this.batchSize, calculateTotal: true }));
      if (queried.position !== records.length || (queryState !== undefined && queried.queryState !== queryState)) throw new JmapProbeError('baseline_changed');
      queryState = queried.queryState;
      if (!queried.ids.length) {
        if (queried.total !== records.length) throw new JmapProbeError('baseline_changed');
        // An empty query still needs an Email state; queryState is a different cursor.
      }
      const got = parse(z.object({ state, list: z.array(email).max(this.batchSize), notFound: z.array(id).max(this.batchSize) }),
        await this.#call('Email/get', { ids: queried.ids, properties: ['id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'size'] }));
      if (got.notFound.length || got.list.length !== queried.ids.length || (emailState !== undefined && got.state !== emailState)) throw new JmapProbeError('baseline_changed');
      emailState = got.state;
      for (const item of got.list) {
        if (!queried.ids.includes(item.id) || seen.has(item.id)) throw new JmapProbeError('invalid_response');
        seen.add(item.id);
        records.push(item);
      }
      if (records.length === queried.total) return { records, queryState, emailState };
      if (!queried.ids.length || records.length > queried.total) throw new JmapProbeError('baseline_changed');
    }
    throw new JmapProbeError('page_limit');
  }
  async changes(sinceState) {
    state.parse(sinceState);
    const pages = [];
    let cursor = sinceState;
    for (let index = 0; index < 10; index++) {
      let data;
      try { data = await this.#call('Email/changes', { sinceState: cursor, maxChanges: this.batchSize }); }
      catch (error) {
        if (error instanceof JmapProbeError && error.code === 'reset_required') return { resetRequired: true, pages: [] };
        throw error;
      }
      const page = parse(z.object({ oldState: state, newState: state, hasMoreChanges: z.boolean(),
        created: z.array(id).max(this.batchSize), updated: z.array(id).max(this.batchSize), destroyed: z.array(id).max(this.batchSize) }), data);
      if (page.oldState !== cursor || (page.hasMoreChanges && page.newState === cursor)) throw new JmapProbeError('cursor');
      pages.push(page);
      cursor = page.newState;
      if (!page.hasMoreChanges) return { resetRequired: false, pages, emailState: cursor };
    }
    throw new JmapProbeError('page_limit');
  }
  async raw(blobId) {
    id.parse(blobId);
    if (!this.#session) throw new JmapProbeError('not_connected');
    return this.#request(this.#session.downloadUrl.replaceAll('{accountId}', this.accountId).replaceAll('{blobId}', blobId)
      .replaceAll('{name}', 'message.eml').replaceAll('{type}', 'message%2Frfc822'), undefined, true);
  }
  async setRead(emailId, expectedState, read) {
    id.parse(emailId); state.parse(expectedState); z.boolean().parse(read);
    if (!this.#session) throw new JmapProbeError('not_connected');
    if (this.#session.accounts[this.accountId].isReadOnly) throw new JmapProbeError('read_only');
    let data;
    try { data = await this.#call('Email/set', { ifInState: expectedState, update: { [emailId]: { 'keywords/$seen': read ? true : null } } }); }
    catch (error) {
      if (error instanceof JmapProbeError && error.code === 'conflict') return 'conflict';
      throw error;
    }
    const result = parse(z.object({ oldState: state, newState: state, updated: z.record(id, z.unknown()).nullable(),
      notUpdated: z.record(id, z.object({ type: z.string() })).nullable() }), data);
    if (result.oldState !== expectedState || (Object.hasOwn(result.updated ?? {}, emailId) && Object.hasOwn(result.notUpdated ?? {}, emailId))) throw new JmapProbeError('invalid_response');
    if (Object.hasOwn(result.notUpdated ?? {}, emailId)) return 'rejected';
    if (Object.hasOwn(result.updated ?? {}, emailId)) return 'succeeded';
    throw new JmapProbeError('invalid_response');
  }
}
