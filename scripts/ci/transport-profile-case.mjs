// Identical binary transport assertions under Bun's test harness and Node's.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { createNodeRawHttpTransport } from '../../apps/server/src/agent-sandbox/raw-http-node.ts';
import { prepareRawHttpRequest } from '../../apps/server/src/agent-sandbox/raw-http.ts';

const { test, afterEach } = await import(process.versions.bun ? 'bun:test' : 'node:test');
const started = performance.now();
const phase = name => console.log(JSON.stringify({ kind: 'transport-profile', phase: name, elapsedMs: Math.round(performance.now() - started) }));
let transport;
afterEach(async () => { await transport?.close(); phase('worker-closed'); });
async function verify() {
  const bytes = Buffer.alloc(17 * 1024 * 1024 + 37);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const digest = value => createHash('sha256').update(value).digest('hex');
  const expected = digest(bytes);
  let upload, host;
  const server = createServer(async (request, response) => {
    host = request.headers.host;
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    upload = Buffer.concat(chunks); phase('origin-received-' + request.url);
    response.writeHead(218, 'Complete custom status', { 'x-full-result': 'yes', ...(request.url === '/gzip' ? { 'content-encoding': 'gzip' } : {}) });
    response.end(request.url === '/gzip' ? gzipSync(bytes) : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = server.address().port;
  transport = createNodeRawHttpTransport(() => path.resolve('apps/desktop/resources/node', process.platform === 'win32' ? 'node.exe' : 'node'));
  try {
    phase('payload-ready');
    const response = await transport.send(prepareRawHttpRequest({ url: `http://never-resolve.invalid:${target}/binary`, method: 'POST', headers: {}, bodyBase64: bytes.toString('base64') }), { address: '127.0.0.1', family: 4 }, new AbortController().signal);
    phase('binary-received');
    assert.equal(host, `never-resolve.invalid:${target}`); assert.equal(digest(upload), expected);
    assert.equal(response.status, 218); assert.equal(response.statusText, 'Complete custom status'); assert.equal(response.headers['x-full-result'], 'yes');
    assert.equal(digest(Buffer.from(response.bodyBase64, 'base64')), expected);
    const decoded = await transport.send(prepareRawHttpRequest({ url: `http://never-resolve.invalid:${target}/gzip`, method: 'GET', headers: {} }), { address: '127.0.0.1', family: 4 }, new AbortController().signal);
    phase('gzip-received');
    assert.equal(decoded.headers['content-encoding'], 'gzip'); assert.equal(digest(Buffer.from(decoded.bodyBase64, 'base64')), expected);
    phase('assertions-complete');
  } finally {
    await new Promise(resolve => server.close(resolve)); phase('server-closed');
  }
}
if (process.versions.bun) test('complete binary transport profile', verify, 30000);
else test('complete binary transport profile', { timeout: 30000 }, verify);
