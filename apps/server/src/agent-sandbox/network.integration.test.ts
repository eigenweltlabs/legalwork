import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmSandbox, type SandboxRun } from "./vm.js";

describe.skipIf(process.env.LEGALWORK_SANDBOX_INTEGRATION !== "1")("real sandbox network modes", () => {
  let root: string;
  const sandbox = new VmSandbox();
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "sandbox-network-")); await sandbox.prepare(); }, 600000);
  afterAll(async () => { await VmSandbox.shutdown(); if (root) await rm(root, { recursive: true, force: true }); });
  const execute = (command: string, networkMode: SandboxRun["networkMode"], authorizeNetwork: SandboxRun["authorizeNetwork"] = async () => { throw new Error("Unexpected approval callback"); }) => sandbox.run({
    command, networkMode, authorizeNetwork, cwd: "/workspace", mounts: [{ source: root, target: "/workspace", writable: false }],
    timeoutMs: 90000, signal: AbortSignal.timeout(180000),
  });

  test("block denies proxy, direct IPv4/IPv6, UDP and DNS without asking", async () => {
    const result = await execute(`python3 - <<'PY'
import socket, urllib.request, urllib.error
def blocked(action):
    try:
        action()
    except OSError:
        return
    raise AssertionError('Blocked network operation succeeded')
blocked(lambda: socket.create_connection(('1.1.1.1', 443), timeout=.5))
blocked(lambda: socket.create_connection(('2606:4700:4700::1111', 443), timeout=.5))
blocked(lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b'canary', ('1.1.1.1', 53)))
blocked(lambda: socket.getaddrinfo('example.com', 443))
try:
    urllib.request.urlopen('https://example.com/', timeout=10)
    raise AssertionError('Blocked HTTP succeeded')
except urllib.error.HTTPError as error:
    assert error.code == 403
print('blocked')
PY`, "block");
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("blocked");
  }, 180000);

  test("allow supports direct TCP, UDP, DNS and verified HTTPS without approval", async () => {
    const sockets = new Set<Socket>();
    const tcp = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.pipe(socket); });
    const tcp6 = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.pipe(socket); });
    const udp = createSocket("udp4");
    udp.on("message", (message, remote) => udp.send(message, remote.port, remote.address));
    tcp.listen(0, "127.0.0.1"); tcp6.listen(0, "::1"); udp.bind(0, "127.0.0.1");
    await Promise.all([once(tcp, "listening"), once(tcp6, "listening"), once(udp, "listening")]);
    const tcpAddress = tcp.address();
    const tcp6Address = tcp6.address();
    if (!tcp6Address || typeof tcp6Address === "string") throw new Error("Missing IPv6 address");
    if (!tcpAddress || typeof tcpAddress === "string") throw new Error("Missing TCP address");
    try {
      const result = await execute(`python3 - <<'PY'
import socket, urllib.request, os
assert 'HTTPS_PROXY' not in os.environ
with socket.create_connection(('10.0.2.2', ${tcpAddress.port}), timeout=10) as s:
    s.sendall(b'direct-tcp-canary')
    assert s.recv(100) == b'direct-tcp-canary'
with socket.create_connection(('fec0::2', ${tcp6Address.port}), timeout=10) as s:
    s.sendall(b'direct-ipv6-canary')
    assert s.recv(100) == b'direct-ipv6-canary'
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
    s.settimeout(10); s.sendto(b'direct-udp-canary', ('10.0.2.2', ${udp.address().port}))
    assert s.recv(100) == b'direct-udp-canary'
assert socket.getaddrinfo('example.com', 443)
assert b'Example Domain' in urllib.request.urlopen('https://example.com/', timeout=20).read()
print('TCP UDP DNS HTTPS passed')
PY`, "allow");
      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toBe("TCP UDP DNS HTTPS passed");
    } finally { for (const socket of sockets) socket.destroy(); tcp.close(); tcp6.close(); udp.close(); }
  }, 180000);

  test("ten unrestricted workers share a VM but cannot connect to each other or a restricted worker", async () => {
    const connections: Array<{ socket: Socket; address: string }> = [];
    const sockets = new Set<Socket>();
    const tcp = createServer((socket) => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket));
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk.toString();
        if (!pending.endsWith("\n")) return;
        connections.push({ socket, address: pending.trim() });
        if (connections.length === 10) connections.forEach((entry, index) => entry.socket.end(connections[(index + 1) % 10].address + "\n"));
      });
    });
    tcp.listen(0, "127.0.0.1"); await once(tcp, "listening");
    const address = tcp.address(); if (!address || typeof address === "string") throw new Error("Missing address");
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 120000);
    const started = performance.now();
    try {
      const [restricted, results] = await Promise.all([
        execute("cat /proc/sys/kernel/random/boot_id", "block"),
        Promise.all(Array.from({ length: 10 }, async (_, index) => {
          const folder = join(root, String(index)); await mkdir(folder); await writeFile(join(folder, "identity"), String(index));
          return sandbox.run({ networkMode: "allow", cwd: "/workspace", mounts: [{ source: folder, target: "/workspace", writable: index % 2 === 0 }],
            timeoutMs: 120000, signal: controller.signal, authorizeNetwork: async () => { throw new Error("Unexpected broker"); },
            command: `python3 - <<'PY'
import json, os, socket, subprocess
from pathlib import Path
assert Path('/workspace/identity').read_text() == '${index}'
Path('/tmp/private-data').write_text('${index}')
listener = socket.socket(); listener.bind(('0.0.0.0', 23456)); listener.listen()
with socket.create_connection(('10.0.2.2', ${address.port}), timeout=60) as s:
    s.sendall((s.getsockname()[0] + '\\n').encode())
    peer = s.makefile().readline().strip()
try:
    socket.create_connection((peer, 23456), timeout=.5)
    raise AssertionError('Another command network is reachable')
except OSError:
    pass
assert Path('/tmp/private-data').read_text() == '${index}'
assert not list(Path('/dev').glob('vport*'))
assert subprocess.run(['unshare', '--net', 'true'], capture_output=True).returncode != 0
try:
    Path('/workspace/result').write_text('${index}')
    assert ${index % 2 === 0 ? "True" : "False"}
except PermissionError:
    assert ${index % 2 !== 0 ? "True" : "False"}
print(json.dumps({'uid': os.getuid(), 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'net': os.readlink('/proc/self/ns/net')}))
PY` });
        })),
      ]);
      const identities = results.map((result) => { expect(result.exitCode).toBe(0); return JSON.parse(result.output); });
      expect(connections).toHaveLength(10);
      expect(new Set(identities.map((value) => value.boot)).size).toBe(1);
      expect(new Set(identities.map((value) => value.net)).size).toBe(10);
      expect(new Set(identities.map((value) => value.uid)).size).toBe(10);
      expect(restricted.output.trim()).not.toBe(identities[0].boot);
      for (let index = 0; index < 10; index++) expect(await readFile(join(root, String(index), "result"), "utf8").catch(() => null)).toBe(index % 2 === 0 ? String(index) : null);
      console.log(`Ten unrestricted commands: ${((performance.now() - started) / 1000).toFixed(2)}s (${process.platform}/${process.arch})`);
    } finally { clearTimeout(deadline); controller.abort(); for (const socket of sockets) socket.destroy(); tcp.close(); }
  }, 180000);
});
