#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { linkTestModules, unlinkTestModules, removeTestTree } from '../../../scripts/mail/link-test-modules.mjs';
const args = process.argv.slice(2), retained = args[0] === '--retained', exporting = args[0] === '--export', count = Number(args[0] ?? 1000), report = resolve(args[retained || exporting ? 2 : 1] ?? 'mail-benchmark.json');
if (retained || exporting ? !args[1] || !args[2] : !Number.isSafeInteger(count) || count < 100 || count > 100000)
    throw Error('Usage: pnpm exec node apps/server/scripts/mail-benchmark.mjs <100..100000 messages> <report.json> OR --retained <synthetic-profile> <new-report.json> OR --export <synthetic-profile> <artifact-directory>');
if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 22)
    throw Error('Actual Node22+ required');
const server = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(join(server, 'package.json')), root = await mkdtemp(join(tmpdir(), 'legalwork-mail-bench-build-'));
async function files(path) {
    const out = [];
    for (const item of await readdir(path, { withFileTypes: true })) {
        const child = join(path, item.name);
        out.push(...item.isDirectory() ? await files(child) : [child]);
    }
    return out;
}
async function run(args) { await new Promise((done, fail) => { const child = spawn(process.execPath, args, { cwd: server, stdio: 'inherit' }); child.on('error', fail); child.on('close', code => code === 0 ? done() : fail(Error('benchmark exit ' + code))); }); }
try {
    const source = join(server, 'src'), paths = await files(join(source, 'mail')), build = join(root, 'build'), project = join(root, 'tsconfig.json');
    await writeFile(project, JSON.stringify({ compilerOptions: { outDir: build, rootDir: source, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, types: ['bun-types', 'node'], typeRoots: [join(server, 'node_modules/@types'), join(server, 'node_modules')] }, files: paths.filter(p => p.endsWith('.ts') && !p.endsWith('.test.ts')) }));
    const digest = createHash('sha256');
    for (const path of paths.filter(p => !p.endsWith('.test.ts') && !p.endsWith('.node-test.mjs')).sort()) {
        digest.update(relative(source, path).replaceAll('\\', '/'));
        digest.update(await readFile(path));
    }
    digest.update(await readFile(fileURLToPath(import.meta.url)));
    digest.update(await readFile(join(server, '../../pnpm-lock.yaml')));
    process.env.LEGALWORK_MAIL_BENCH_SOURCE_SHA256 = digest.digest('hex');
    await run([require.resolve('typescript/bin/tsc'), '--project', project]);
    await writeFile(join(build, 'package.json'), '{"type":"module"}');
    await linkTestModules(join(server, 'node_modules'), join(build, 'node_modules'));
    for (const path of paths.filter(p => p.endsWith('.mjs') && !p.endsWith('.node-test.mjs'))) {
        const target = join(build, relative(source, path));
        await mkdir(dirname(target), { recursive: true });
        await copyFile(path, target);
    }
    await run([join(build, exporting ? 'mail/testing/export-benchmark-profile.mjs' : retained ? 'mail/testing/retained-mailbox-benchmark.mjs' : 'mail/testing/large-mailbox-benchmark.mjs'), retained || exporting ? resolve(args[1]) : String(count), report]);
}
finally {
    await unlinkTestModules(join(root, 'build/node_modules'));
    await removeTestTree(root);
}
