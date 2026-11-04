import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('./archive-payload.py', import.meta.url));
test('release archive verification rejects changed bytes, modes, links and missing files', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'release-archive-payload-'));
  try {
    const app = path.join(root, 'app'), manifest = path.join(root, 'payload.json');
    mkdirSync(path.join(app, 'resources'), { recursive: true });
    writeFileSync(path.join(app, 'legalwork'), 'the executable\n');
    chmodSync(path.join(app, 'legalwork'), 0o755);
    writeFileSync(path.join(app, 'resources', 'app.asar'), 'the signed app payload\n');
    symlinkSync('resources/app.asar', path.join(app, 'payload-link'));
    execFileSync('python3', [helper, 'seal', app, manifest]);
    for (const mutation of ['none', 'content', 'mode', 'link', 'missing', 'traversal']) {
      const archive = path.join(root, `${mutation}.tar.gz`);
      execFileSync('python3', ['-c', `
import io, pathlib, sys, tarfile
root, archive, mutation = sys.argv[1:]
prefix = pathlib.Path(archive).name.removesuffix('.tar.gz')
with tarfile.open(archive, 'w:gz', compresslevel=6) as output:
    for item in pathlib.Path(root).rglob('*'):
        name = prefix + '/' + item.relative_to(root).as_posix()
        info = output.gettarinfo(str(item), arcname=name)
        if mutation == 'missing' and item.name == 'app.asar': continue
        if mutation == 'mode' and item.name == 'legalwork': info.mode = 0o644
        if mutation == 'link' and item.is_symlink(): info.linkname = '../outside'
        if mutation == 'traversal' and item.name == 'legalwork': info.name = prefix + '/../outside'
        if info.isfile():
            content = b'altered payload' if mutation == 'content' and item.name == 'app.asar' else item.read_bytes()
            info.size = len(content)
            output.addfile(info, io.BytesIO(content))
        else: output.addfile(info)
`, app, archive, mutation]);
      const result = spawnSync('python3', [helper, 'verify', archive, manifest], { encoding: 'utf8' });
      assert.equal(result.status === 0, mutation === 'none', `${mutation}: ${result.stderr}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
