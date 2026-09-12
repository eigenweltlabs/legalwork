#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile, symlink, realpath, copyFile, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), count = Number(args[0] ?? 1000), report = resolve(args[1] ?? 'mail-benchmark.json');
if (!Number.isSafeInteger(count) || count < 100 || count > 100000)
    throw Error('Usage: pnpm exec node apps/server/scripts/mail-benchmark.mjs <100..100000 messages> <report.json>');
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
async function run(args) { await new Promise((done, fail) => { const child = spawn(process.execPath, args, { cwd: server, stdio: 'inherit' }); child.on('error', fail); child.on('exit', code => code === 0 ? done() : fail(Error('benchmark exit ' + code))); }); }
try {
    const source = join(server, 'src'), paths = await files(join(source, 'mail')), build = join(root, 'build'), project = join(root, 'tsconfig.json');
    await writeFile(project, JSON.stringify({ compilerOptions: { outDir: build, rootDir: source, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true, types: ['bun-types', 'node'], typeRoots: [join(server, 'node_modules/@types'), join(server, 'node_modules')] }, files: paths.filter(p => p.endsWith('.ts') && !p.endsWith('.test.ts')) }));
    const digest = createHash('sha256');
    for (const path of paths.filter(p => !p.endsWith('.test.ts') && !p.endsWith('.node-test.mjs')).sort()) {
        digest.update(relative(source, path));
        digest.update(await readFile(path));
    }
    digest.update(await readFile(fileURLToPath(import.meta.url)));
    process.env.LEGALWORK_MAIL_BENCH_SOURCE_SHA256 = digest.digest('hex');
    await run([require.resolve('typescript/bin/tsc'), '--project', project]);
    await writeFile(join(build, 'package.json'), '{"type":"module"}');
    await symlink(await realpath(join(server, 'node_modules')), join(build, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of paths.filter(p => p.endsWith('.mjs') && !p.endsWith('.node-test.mjs'))) {
        const target = join(build, relative(source, path));
        await mkdir(dirname(target), { recursive: true });
        await copyFile(path, target);
    }
    await run([join(build, 'mail/testing/large-mailbox-benchmark.mjs'), String(count), report]);
}
finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
