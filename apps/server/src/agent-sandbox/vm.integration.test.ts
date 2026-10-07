import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmSandbox } from "./vm.js";

// CI runs these against the packaged VM assets. Mock-only tests cannot
// demonstrate an operating-system isolation boundary.
describe.skipIf(process.env.LEGALWORK_SANDBOX_INTEGRATION !== "1")("real agent sandbox", () => {
  const sandbox = new VmSandbox();
  let workspace: string;
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "legalwork-sandbox-canary-"));
    await sandbox.prepare();
  }, 600_000);
  afterAll(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });
  const run = (command: string, writable = false, signal = new AbortController().signal) => sandbox.run({
    command, cwd: "/workspace", mounts: [{ source: workspace, target: "/workspace", writable }],
    timeoutMs: 20_000, signal, authorizeNetwork: async () => false,
  });

  test("Python and Node work, approved writes appear in the project", async () => {
    const result = await run(`set -e
python3 - <<'PY'
import docx, openpyxl, pptx, pypdf, reportlab, PIL
from reportlab.pdfgen import canvas
d = docx.Document(); d.add_paragraph('protected document'); d.save('probe.docx')
assert docx.Document('probe.docx').paragraphs[0].text == 'protected document'
w = openpyxl.Workbook(); w.active['A1'] = 42; w.save('probe.xlsx')
assert openpyxl.load_workbook('probe.xlsx').active['A1'].value == 42
c = canvas.Canvas('probe.pdf'); c.drawString(20, 20, 'protected PDF'); c.save()
assert len(pypdf.PdfReader('probe.pdf').pages) == 1
print(6 * 7)
PY
node -e 'console.log(7 * 6)'
echo approved > allowed.txt`, true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("42\n42\n");
    expect((await readFile(join(workspace, "allowed.txt"), "utf8")).trim()).toBe("approved");
  }, 180_000);

  test("large binary transfers and installed read-only helpers survive transport backpressure", async () => {
    const skill = await mkdtemp(join(tmpdir(), "sandbox-skill-"));
    try {
      const bytes = randomBytes(2 * 1024 * 1024 + 17);
      await writeFile(join(workspace, "binary.bin"), bytes);
      await writeFile(join(skill, "helper.py"), `from pathlib import Path
Path('/workspace/copied.bin').write_bytes(Path('/workspace/binary.bin').read_bytes())
try:
    Path('/skills/0/forbidden').write_text('escape')
except OSError:
    print('skill protected')
else:
    raise RuntimeError('skill was writable')
`);
      const result = await sandbox.run({ command: "python3 /skills/0/helper.py", cwd: "/workspace",
        mounts: [{ source: workspace, target: "/workspace", writable: true }, { source: skill, target: "/skills/0", writable: false }],
        timeoutMs: 20000, signal: new AbortController().signal, authorizeNetwork: async () => false });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("skill protected");
      expect(await readFile(join(workspace, "copied.bin"))).toEqual(bytes);
      expect(await readFile(join(skill, "forbidden")).catch(() => null)).toBeNull();
    } finally {
      await rm(skill, { recursive: true, force: true });
      await rm(join(workspace, "binary.bin"), { force: true });
      await rm(join(workspace, "copied.bin"), { force: true });
    }
  }, 180000);

  test("multiple folders keep separate destinations and read-only boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-multiple-folders-"));
    const inputs = join(root, "reference"), outputs = join(root, "output");
    try {
      await mkdir(inputs); await mkdir(outputs);
      await writeFile(join(inputs, "input.txt"), "reference text");
      await writeFile(join(outputs, "input.txt"), "output text");
      await writeFile(join(root, "unshared.txt"), "not authorized");
      await writeFile(join(workspace, "multiple-folders.py"), `from pathlib import Path
assert Path('/authorized/0/input.txt').read_text() == 'reference text'
assert Path('/authorized/1/input.txt').read_text() == 'output text'
try:
    Path('/authorized/0/input.txt').write_text('forbidden')
except OSError:
    pass
else:
    raise RuntimeError('read-only reference folder was writable')
assert not Path(${JSON.stringify(join(root, "unshared.txt"))}).exists()
Path('/workspace/combined.txt').write_text(Path('/authorized/0/input.txt').read_text() + ' + ' + Path('/authorized/1/input.txt').read_text())
Path('/authorized/1/result.txt').write_text('external output')
print('multiple folders passed')
`);
      const result = await sandbox.run({ command: "python3 /workspace/multiple-folders.py", cwd: "/authorized/1",
        mounts: [
          { source: workspace, target: "/workspace", writable: true },
          { source: inputs, target: "/authorized/0", writable: false },
          { source: outputs, target: "/authorized/1", writable: true },
        ], timeoutMs: 20000, signal: new AbortController().signal, authorizeNetwork: async () => false });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("multiple folders passed");
      expect(await readFile(join(workspace, "combined.txt"), "utf8")).toBe("reference text + output text");
      expect(await readFile(join(outputs, "result.txt"), "utf8")).toBe("external output");
      expect(await readFile(join(inputs, "input.txt"), "utf8")).toBe("reference text");
      expect(await readFile(join(root, "unshared.txt"), "utf8")).toBe("not authorized");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(join(workspace, "multiple-folders.py"), { force: true });
      await rm(join(workspace, "combined.txt"), { force: true });
    }
  }, 180000);

  test("large folders start without copying their contents and large files support random reads", async () => {
    const length = 2 * 1024 ** 3;
    const path = join(workspace, "large-input.bin");
    const file = await open(path, "wx");
    try {
      await file.truncate(length);
      await file.write(Buffer.from("tail"), 0, 4, length - 4);
    } finally { await file.close(); }
    try {
      const result = await run(`python3 -c 'import os; p="large-input.bin"; assert os.stat(p).st_size == ${length}; f=open(p,"rb"); f.seek(${length - 4}); assert f.read() == b"tail"; print("large file read lazily")'`);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("large file read lazily\n");
    } finally { await rm(path, { force: true }); }
  }, 180000);

  test("the operating system blocks raw traffic, DNS, host IPC and private supervisor state", async () => {
    const script = `import socket, os, json, subprocess
results = {}
def blocked(name, action):
    try:
        action()
        results[name] = False
    except (OSError, PermissionError):
        results[name] = True
blocked("ipv4", lambda: socket.create_connection(("1.1.1.1", 443), timeout=0.3))
blocked("ipv6", lambda: socket.create_connection(("2606:4700:4700::1111", 443), timeout=0.3))
blocked("dns", lambda: socket.getaddrinfo("legalwork-canary.invalid", 443))
blocked("udp_dns", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"canary", ("1.1.1.1", 53)))
blocked("icmp", lambda: socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP))
blocked("docker_socket", lambda: socket.socket(socket.AF_UNIX).connect("/var/run/docker.sock"))
blocked("supervisor_environment", lambda: open("/proc/1/environ", "rb").read())
blocked("proxy_private_key", lambda: open("/tmp/private/ca.key", "rb").read())
blocked("runtime_write", lambda: open("/opt/legalwork/relay.py", "w"))
blocked("project_write", lambda: open("/workspace/forbidden.txt", "w"))
results["no_host_credentials"] = not any(k.startswith(("LEGALWORK_", "OPENCODE_", "AWS_", "OPENAI_", "ANTHROPIC_")) for k in os.environ)
results["not_root"] = os.getuid() != 0
results["child_network"] = subprocess.run(["python3", "-c", "import socket; socket.create_connection(('1.1.1.1',443),timeout=.3)"], capture_output=True).returncode != 0
print(json.dumps(results))
`;
    await writeFile(join(workspace, "canary.py"), script);
    const result = await run("env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy python3 canary.py");
    expect(result.exitCode).toBe(0);
    const checks = JSON.parse(result.output);
    expect(Object.keys(checks)).toHaveLength(13);
    for (const [name, passed] of Object.entries(checks)) expect({ [name]: passed }).toEqual({ [name]: true });
  }, 180_000);

  test("HTTPS is inspected and denied through the broker even with an ordinary curl client", async () => {
    const requests: string[] = [];
    const result = await sandbox.run({ command: "curl --silent --show-error --fail https://example.com/ --data 'synthetic-canary'",
      cwd: "/workspace", mounts: [{ source: workspace, target: "/workspace", writable: false }],
      timeoutMs: 20_000, signal: new AbortController().signal,
      authorizeNetwork: async (request) => {
        requests.push(request.url);
        expect(Buffer.from(request.bodyBase64, "base64").toString()).toBe("synthetic-canary");
        return false;
      },
    });
    expect(result.exitCode).not.toBe(0);
    expect(requests).toEqual(["https://example.com/"]);
    expect(result.output).toContain("403");
  }, 180_000);

  test("approved curl, Python and Node HTTPS can complete through the broker", async () => {
    const requests: string[] = [];
    const result = await sandbox.run({ command: `set -e
curl --silent --show-error --fail https://example.com/
python3 -c 'import urllib.request; assert b"Example Domain" in urllib.request.urlopen("https://example.com/").read(); print("Python HTTPS passed")'
node -e 'fetch("https://example.com/").then(r=>r.text()).then(t=>{if(!t.includes("Example Domain")) process.exit(1); console.log("Node HTTPS passed")})'`,
      cwd: "/workspace", mounts: [{ source: workspace, target: "/workspace", writable: false }],
      timeoutMs: 30_000, signal: new AbortController().signal,
      authorizeNetwork: async (request) => { requests.push(request.url); return true; },
    });
    expect(result.exitCode).toBe(0);
    expect(requests).toEqual(Array(3).fill("https://example.com/"));
    expect(result.output).toContain("Example Domain");
    expect(result.output).toContain("Python HTTPS passed");
    expect(result.output).toContain("Node HTTPS passed");
  }, 180_000);

  test("cancellation destroys the VM without copying pending changes", async () => {
    const controller = new AbortController();
    const promise = run("echo started > started.txt; (sleep 30; echo escaped > late.txt) & wait", true, controller.signal);
    // Changes stay inside the guest until successful completion.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(await readFile(join(workspace, "started.txt"), "utf8").catch(() => null)).toBeNull();
    expect(await readFile(join(workspace, "late.txt"), "utf8").catch(() => null)).toBeNull();
  }, 180_000);
});
