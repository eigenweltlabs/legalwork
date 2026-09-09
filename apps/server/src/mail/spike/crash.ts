/** Child-process crash fixture; only writes a caller-provided synthetic database. */
import { openSpike, initial } from './store.js';
const path = process.argv[2];
if (!path) throw new Error('Synthetic database path required');
const store = await openSpike(path);
await store.syncPage('crash', async request => {
  if (request.url !== initial) throw new Error('Unexpected fixture URL');
  return new Response(JSON.stringify({ value: [], '@odata.deltaLink': `${initial}?done=1` }));
}, () => process.kill(process.pid, 'SIGKILL'));
throw new Error('Crash fixture unexpectedly survived');
