import { createServer, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VmSandbox } from "../../apps/server/src/agent-sandbox/vm.js";

const sandbox = new VmSandbox(resolve(process.argv[2]));
const workspace = await mkdtemp(join(tmpdir(), "legalwork-isolation-probe-"));
const results: Record<string, unknown> = { platform: process.platform, architecture: process.arch };
const started = Date.now();
try {
  const run = (command: string, writable = false) => sandbox.run({ command, cwd: "/workspace",
    mounts: [{ source: workspace, target: "/workspace", writable }], timeoutMs: 30000,
    signal: AbortSignal.timeout(180000), authorizeNetwork: async () => false });
  const largeSize = 2 * 1024 ** 3;
  const large = await open(join(workspace, "large.bin"), "wx");
  try { await large.truncate(largeSize); await large.write(Buffer.from("tail"), 0, 4, largeSize - 4); }
  finally { await large.close(); }
  await writeFile(join(workspace, "canary.py"), `import os, socket, subprocess, json, glob
checks = {}
def blocked(name, action):
    try:
        action()
        checks[name] = False
    except OSError:
        checks[name] = True
blocked("ipv4", lambda: socket.create_connection(("1.1.1.1", 443), timeout=.5))
blocked("ipv6", lambda: socket.create_connection(("2606:4700:4700::1111", 443), timeout=.5))
blocked("dns", lambda: socket.getaddrinfo("example.com", 443))
blocked("udp", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"canary", ("1.1.1.1", 53)))
blocked("read_only", lambda: open("/workspace/forbidden", "w"))
blocked("private_supervisor", lambda: open("/proc/1/environ", "rb").read())
blocked("host_channel", lambda: open("/dev/vport0p1", "r+b"))
checks["no_host_channels"] = not glob.glob('/dev/vport*')
checks["nonroot"] = os.getuid() != 0
checks["no_host_environment"] = not any(k.startswith(("AWS_", "OPENAI_", "LEGALWORK_", "OPENCODE_")) for k in os.environ)
with open('/workspace/large.bin', 'rb') as large:
    large.seek(${largeSize - 4})
    checks["large_file_random_read"] = large.read() == b'tail'
print(json.dumps(checks))
`);
  const probe = await run("python3 canary.py");
  assert.equal(probe.exitCode, 0, probe.output);
  const checks = JSON.parse(probe.output);
  for (const [name, value] of Object.entries(checks)) assert.equal(value, true, name);
  results.isolation = checks;
  await rm(join(workspace, "large.bin"));
  const binary = randomBytes(2 * 1024 * 1024 + 17);
  await writeFile(join(workspace, "input.bin"), binary);
  const write = await run("python3 -c 'import docx, openpyxl, pptx, pypdf, reportlab, PIL; open(\"result.txt\",\"w\").write(\"approved\"); open(\"output.bin\",\"wb\").write(open(\"input.bin\",\"rb\").read())'; node -e 'console.log(42)'", true);
  assert.equal(write.exitCode, 0, write.output);
  assert.equal(write.output.trim(), "42");
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "approved");
  assert.deepEqual(await readFile(join(workspace, "output.bin")), binary);
  await rm(join(workspace, "input.bin"));
  await rm(join(workspace, "output.bin"));
  results.python_node_and_copyback = true;
  results.large_binary_roundtrip_and_document_libraries = true;
  const requests: string[] = [];
  const blocked = await sandbox.run({ command: "curl --fail --silent --show-error https://example.com/ --data synthetic-canary",
    cwd: "/workspace", mounts: [{ source: workspace, target: "/workspace", writable: false }], timeoutMs: 30000,
    signal: AbortSignal.timeout(180000), authorizeNetwork: async (request) => {
      assert.equal(Buffer.from(request.bodyBase64, "base64").toString(), "synthetic-canary");
      requests.push(request.url); return false;
    } });
  assert.notEqual(blocked.exitCode, 0);
  assert.deepEqual(requests, ["https://example.com/"]);
  results.https_request_inspected_and_denied = true;
  const approvedRequests: string[] = [];
  const approved = await sandbox.run({ command: `set -e
python3 -c 'import urllib.request; assert b"Example Domain" in urllib.request.urlopen("https://example.com/").read(); print("Python HTTPS passed")'
node -e 'fetch("https://example.com/").then(r=>r.text()).then(t=>{if(!t.includes("Example Domain")) process.exit(1); console.log("Node HTTPS passed")})'`,
    cwd: "/workspace", mounts: [{ source: workspace, target: "/workspace", writable: false }], timeoutMs: 30000,
    signal: AbortSignal.timeout(180000), authorizeNetwork: async (request) => {
      approvedRequests.push(request.url); return true;
    } });
  assert.equal(approved.exitCode, 0, approved.output);
  assert.deepEqual(approvedRequests, Array(2).fill("https://example.com/"));
  assert.ok(approved.output.includes("Python HTTPS passed"));
  assert.ok(approved.output.includes("Node HTTPS passed"));
  results.python_and_node_approved_https = true;
  const tcpSockets = new Set<Socket>();
  const tcp = createServer((socket) => { tcpSockets.add(socket); socket.on("close", () => tcpSockets.delete(socket)); socket.pipe(socket); });
  const udp = createSocket("udp4");
  udp.on("message", (message, remote) => udp.send(message, remote.port, remote.address));
  tcp.listen(0, "127.0.0.1"); udp.bind(0, "127.0.0.1");
  await Promise.all([once(tcp, "listening"), once(udp, "listening")]);
  const address = tcp.address(); if (!address || typeof address === "string") throw new Error("Missing TCP address");
  try {
    const start = Date.now();
    const direct = await Promise.all(Array.from({ length: 10 }, (_, index) => sandbox.run({
      networkMode: "allow", cwd: "/workspace", mounts: [{ source: workspace, target: "/workspace", writable: false }],
      timeoutMs: 90000, signal: AbortSignal.timeout(180000), authorizeNetwork: async () => { throw new Error("Unexpected broker"); },
      command: `python3 - <<'PY'
import socket, os, json
from pathlib import Path
Path('/tmp/identity').write_text('${index}')
with socket.create_connection(('10.0.2.2', ${address.port}), timeout=30) as s:
    s.sendall(b'tcp-canary')
    assert s.recv(100) == b'tcp-canary'
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
    s.settimeout(30); s.sendto(b'udp-canary', ('10.0.2.2', ${udp.address().port}))
    assert s.recv(100) == b'udp-canary'
assert Path('/tmp/identity').read_text() == '${index}'
print(json.dumps({'uid':os.getuid(), 'boot':Path('/proc/sys/kernel/random/boot_id').read_text()}))
PY` })));
    const identities = direct.map((result) => { assert.equal(result.exitCode, 0, result.output); return JSON.parse(result.output); });
    assert.equal(new Set(identities.map((value) => value.uid)).size, 10);
    assert.equal(new Set(identities.map((value) => value.boot)).size, 1);
    results.ten_direct_tcp_udp_commands_seconds = (Date.now() - start) / 1000;
    const blocked = await sandbox.run({ command: "curl --fail --silent --show-error https://example.com/", networkMode: "block",
      cwd: "/workspace", mounts: [{ source: workspace, target: "/workspace", writable: false }], timeoutMs: 30000,
      signal: AbortSignal.timeout(180000), authorizeNetwork: async () => { throw new Error("Block must never ask"); } });
    assert.notEqual(blocked.exitCode, 0);
    results.block_without_approval = true;
  } finally { for (const socket of tcpSockets) socket.destroy(); tcp.close(); udp.close(); }
  results.seconds = (Date.now() - started) / 1000;
  console.log(JSON.stringify(results, null, 2));
} finally { await VmSandbox.shutdown(); await rm(workspace, { recursive: true, force: true }); }
