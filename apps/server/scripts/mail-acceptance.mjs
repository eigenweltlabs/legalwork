#!/usr/bin/env node
/** Compile once and run the real Node mail suites, including native encrypted SQLite. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let concurrency = '2';
let suite = null;
let suiteSet = null;
let testNamePattern = null;
const seen = new Set();
for (let index = 0; index < args.length; index += 2) {
  const option = args[index], value = args[index + 1];
  if (seen.has(option) || value === undefined ||
      (option !== '--concurrency' && option !== '--suite' && option !== '--suite-set' && option !== '--test-name-pattern') ||
      (option === '--concurrency' && !/^[1-8]$/.test(value)) ||
      (option === '--suite-set' && value !== 'provider-recovery') ||
      (option === '--suite' && !/^[a-z][a-z0-9/-]*$/.test(value)) ||
      (option === '--test-name-pattern' && (!value.length || value.length > 256 || value.includes('\0')))) {
    throw new Error('Usage: node apps/server/scripts/mail-acceptance.mjs [--concurrency 1..8] [--suite storage/database | --suite-set provider-recovery] [--test-name-pattern pattern]');
  }
  seen.add(option);
  if (option === '--concurrency') concurrency = value;
  else if (option === '--suite') suite = value;
  else if (option === '--suite-set') suiteSet = value;
  else testNamePattern = value;
}
if (suite !== null && suiteSet !== null) throw Error('Choose --suite or --suite-set');
if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('Mail acceptance requires actual Node 22 or newer; native addons must not load in Bun.');
}
const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(server, 'src');
const mail = join(source, 'mail');
const require = createRequire(join(server, 'package.json'));
const compiler = require.resolve('typescript/bin/tsc');
const output = await mkdtemp(join(tmpdir(), 'legalwork-mail-acceptance-'));
const started = performance.now();
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
async function run(arguments_, timeout) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, arguments_, { cwd: server, stdio: 'inherit', shell: false });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else reject(new Error(`Mail acceptance subprocess failed (exit=${code}, signal=${signal ?? 'none'}).`));
    });
  });
}
try {
  const paths = await files(mail);
  const selected = suiteSet ? JSON.parse(await readFile(join(server, 'scripts/mail-provider-suites.json'), 'utf8')) : null;
  if (selected && (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9/-]*$/.test(value)))) throw Error('Invalid provider suite manifest');
  const fixtures = paths.filter(path => path.endsWith('.node-test.mjs') &&
    (selected ? selected.includes(relative(mail, path).replaceAll('\\', '/').replace(/\.node-test\.mjs$/, '')) : suite === null || relative(mail, path).replaceAll('\\', '/') === `${suite}.node-test.mjs`));
  if (selected && fixtures.length !== selected.length) throw Error('Missing provider certification suite');
  if (fixtures.length === 0) throw new Error('No matching native mail suites found.');
  const production = paths.filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts'));
  // HTTP journey fixtures import the real mail routes outside src/mail.
  production.push(...(await files(join(source, 'routes'))).filter(path => /[/\\]mail[^/\\]*\.ts$/.test(path) && !path.endsWith('.test.ts')));
  // A JSON project avoids Windows command-line length and escaping limits.
  const project = join(output, 'tsconfig.json');
  await writeFile(project, JSON.stringify({ compilerOptions: {
    outDir: join(output, 'build'), rootDir: source, target: 'ES2022', module: 'NodeNext',
    moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, types: ['bun-types', 'node'],
    typeRoots: [join(server, 'node_modules/@types'), join(server, 'node_modules')],
  }, files: production }));
  console.log(`Mail acceptance: ${process.platform}/${process.arch}, Node ${process.versions.node}; one compilation, concurrency ${concurrency}.`);
  await run([compiler, '--project', project], 120_000);
  const build = join(output, 'build');
  await writeFile(join(build, 'package.json'), '{"type":"module"}');
  await symlink(await realpath(join(server, 'node_modules')), join(build, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Native fixtures and their checked-in data/worker scripts keep their source-relative layout.
  const artifacts = paths.filter(path => !path.endsWith('.ts') && !path.endsWith('.md'));
  for (const path of artifacts) {
    const destination = join(build, relative(source, path));
    await mkdir(dirname(destination), { recursive: true });
    await cp(path, destination);
  }
  // Main-process recovery is exercised through the actual private Node worker.
  for (const name of ['mail-store-maintenance.mjs', 'mail-key-store.mjs']) {
    await cp(join(server, '../desktop/electron', name), join(build, name));
  }
  if (selected) {
    const digest = createHash('sha256');
    const inputs = [...paths, fileURLToPath(import.meta.url), join(server, 'scripts/mail-provider-suites.json'), ...['mail-store-maintenance.mjs','mail-key-store.mjs'].map(name=>join(server,'../desktop/electron',name))].sort();
    for (const path of inputs) { digest.update(relative(server,path).replaceAll('\\','/')); digest.update(await readFile(path)); }
    console.log('Provider recovery source SHA-256: ' + digest.digest('hex'));
    console.log('Provider recovery suites: ' + JSON.stringify(selected));
  }
  const suites = fixtures.map(path => join(build, relative(source, path)));
  if (suites.length === 0) throw new Error('No native mail suites found.');
  console.log(`Running ${suite === null ? 'all ' : 'selected '}${suites.length} native mail suites (no provider network or real credentials).`);
  if (testNamePattern) console.log(`Test name filter: ${testNamePattern}`);
  await run(['--test', ...(selected ? ['--test-reporter=tap'] : []), `--test-concurrency=${concurrency}`, ...(testNamePattern ? [`--test-name-pattern=${testNamePattern}`] : []), ...suites], 300_000);
  console.log(`Mail acceptance passed in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
} finally {
  await rm(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
