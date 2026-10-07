import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await writeFile(join(workspace, "canary.py"), `import os, socket, subprocess, json
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
checks["nonroot"] = os.getuid() != 0
checks["no_host_environment"] = not any(k.startswith(("AWS_", "OPENAI_", "LEGALWORK_", "OPENCODE_")) for k in os.environ)
print(json.dumps(checks))
`);
  const probe = await run("python3 canary.py");
  assert.equal(probe.exitCode, 0, probe.output);
  const checks = JSON.parse(probe.output);
  for (const [name, value] of Object.entries(checks)) assert.equal(value, true, name);
  results.isolation = checks;
  const write = await run("python3 -c 'open(\"result.txt\",\"w\").write(\"approved\")'; node -e 'console.log(42)'", true);
  assert.equal(write.exitCode, 0, write.output);
  assert.equal(write.output.trim(), "42");
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "approved");
  results.python_node_and_copyback = true;
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
  results.seconds = (Date.now() - started) / 1000;
  console.log(JSON.stringify(results, null, 2));
} finally { await rm(workspace, { recursive: true, force: true }); }
