import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [directory, fixture] = process.argv.slice(2);
const results = { arch: process.arch, node: process.version, fixtureFiles: 2000, before: [], after: [] };
const handlers = {};
for (const [label, file] of [['before', 'files.js'], ['after', 'files-speed-review.js']]) {
  const { registerFileRoutes } = await import(pathToFileURL(path.join(directory, file)));
  const routes = [];
  registerFileRoutes({ routes, config: {}, jsonResponse: Response.json,
    resolveWorkspace: async () => ({ id: 'ws_speed', path: fixture }) });
  handlers[label] = routes.find(r => r.method === 'GET' && r.regex.test('/workspace/ws_speed/files/list')).handler;
}
let expected;
for (let run=0; run<6; run++) for (const label of run%2 ? ['after', 'before'] : ['before', 'after']) {
  const start = performance.now();
  const response = await handlers[label]({ params: { id: 'ws_speed' }, url: new URL('http://localhost/workspace/ws_speed/files/list') });
  const result = await response.json();
  results[label].push(Math.round((performance.now()-start)*10)/10);
  assert.equal(result.entries.length, 2000);
  if (!expected) expected = result;
  else assert.deepEqual(result, expected);
}
console.log(JSON.stringify(results));
