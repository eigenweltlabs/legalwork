import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('QEMU install selection includes generated trace and firmware while excluding uninstalled test programs', () => {
  const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', `
import importlib.util, json, pathlib, tempfile
spec = importlib.util.spec_from_file_location('build_installed_qemu', 'scripts/sandbox/build-installed-qemu.py')
helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
with tempfile.TemporaryDirectory() as root:
 build = pathlib.Path(root).resolve() / 'build'; build.mkdir()
 available = {'qemu-system-aarch64', 'qemu-system-aarch64-unsigned', 'trace/trace-events-all', 'pc-bios/firmware.fd', 'tests/qtest/test-program'}
 installed = {str(build / name): '/prefix/' + name for name in ['qemu-system-aarch64-unsigned', 'trace/trace-events-all', 'pc-bios/firmware.fd']}
 configured = build / 'configured.json'; configured.write_text('{}'); installed[str(configured)] = '/prefix/configured.json'
 installed[str(pathlib.Path(root) / 'COPYING')] = '/prefix/COPYING'
 result = helper.installed_targets(build, installed, available, 'qemu-system-aarch64')
 assert result == ['pc-bios/firmware.fd', 'qemu-system-aarch64', 'qemu-system-aarch64-unsigned', 'trace/trace-events-all'], result
 installed[str(build / 'missing-generated-file')] = '/prefix/missing'
 try: helper.installed_targets(build, installed, available, 'qemu-system-aarch64')
 except ValueError: pass
 else: raise AssertionError('Unbuilt install prerequisites must fail before installation')
 print(json.dumps({'selected': result}))
`], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).selected.length, 4);
});
