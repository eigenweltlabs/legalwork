import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOfficeConnectionToken, OfficeConnectionService } from "./office-connection.js";

const installation = "test-office-installation-credential";
function request(path = "/word-addin/session", token?: string, origin = "https://localhost:47443", launch?: string) {
  return new Request(`${origin}${path}`, { method: "POST", headers: {
    Host: new URL(origin).host, Origin: origin,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(launch ? { "X-LegalWork-Office-Launch": launch } : {}),
  } });
}

test("Office connects silently only with the installed credential and retains limited authority", () => {
  const office = new OfficeConnectionService(installation);
  expect(() => office.connect(request())).toThrow();
  expect(() => office.connect(request(undefined, undefined, undefined, "wrong"))).toThrow();
  const { token } = office.connect(request(undefined, undefined, undefined, installation));
  expect(token).toStartWith("office_");
  expect(token).not.toContain(installation);
  expect(office.actor(request("/whoami", token))).toMatchObject({ scope: "collaborator" });
  expect(() => office.actor(request("/env", token), true)).toThrow();
  expect(office.actor(request("/workspaces/pick-folder", token), true)).toMatchObject({ scope: "collaborator" });
});

test("Office credentials survive restarts and are invalidated when the installation credential changes", () => {
  const first = new OfficeConnectionService(installation);
  const { token } = first.connect(request(undefined, undefined, undefined, installation));
  first.dispose();
  expect(() => first.actor(request("/whoami", token))).toThrow();
  expect(new OfficeConnectionService(installation).actor(request("/whoami", token))).toMatchObject({ clientId: "Office add-in" });
  expect(() => new OfficeConnectionService("new-installation").actor(request("/whoami", token))).toThrow();
});

test("Office rejects other origins, rebinding hosts, and reuse at a different local port", () => {
  const office = new OfficeConnectionService(installation);
  const { token } = office.connect(request(undefined, undefined, undefined, installation));
  expect(() => office.actor(request("/whoami", token, "https://localhost:9999"))).toThrow();
  const untrusted: HeadersInit[] = [
    { Host: "localhost:47443", Origin: "https://evil.example" },
    { Host: "evil.example", Origin: "https://evil.example" },
    { Host: "localhost:47443", Origin: "null" },
    { Host: "localhost:47443", "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of untrusted) expect(() => office.connect(new Request("https://localhost:47443/word-addin/session", { method: "POST", headers: { ...headers, "X-LegalWork-Office-Launch": installation } }))).toThrow();
});

test("concurrent starts retain one private installation credential and never replace invalid data", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-connection-"));
  try {
    const keyPath = join(root, "localhost.key");
    const tokens = await Promise.all(Array.from({ length: 8 }, () => loadOfficeConnectionToken(keyPath)));
    expect(new Set(tokens).size).toBe(1);
    expect(await loadOfficeConnectionToken(keyPath)).toBe(tokens[0]);
    if (process.platform !== "win32") expect((await stat(join(root, "office-connection.token"))).mode & 0o777).toBe(0o600);
    await writeFile(join(root, "office-connection.token"), "invalid");
    await expect(loadOfficeConnectionToken(keyPath)).rejects.toThrow("Invalid local Office connection credential");
  } finally { await rm(root, { recursive: true, force: true }); }
});
