#!/usr/bin/env node
/** Compile once and run the real Node mail suites, including native encrypted SQLite. */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--concurrency' || !/^[1-8]$/.test(args[1]))) {
  throw new Error('Usage: node apps/server/scripts/mail-acceptance.mjs [--concurrency 1..8]');
}
if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('Mail acceptance requires actual Node 22 or newer; native addons must not load in Bun.');
}
const concurrency = args[1] ?? '2';
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
  const production = paths.filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts'));
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
  const suites = paths.filter(path => path.endsWith('.node-test.mjs')).map(path => join(build, relative(source, path)));
  if (suites.length === 0) throw new Error('No native mail suites found.');
  console.log(`Running all ${suites.length} native mail suites (no provider network or real credentials).`);
  await run(['--test', `--test-concurrency=${concurrency}`, ...suites], 300_000);
  console.log(`Mail acceptance passed in ${((performance.now() - started) / 1000).toFixed(1)}s.`);
} finally {
  await rm(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
