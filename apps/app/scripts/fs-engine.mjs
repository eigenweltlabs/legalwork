import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  findFreePort,
  makeClient,
  parseArgs,
  spawnOpencodeServe,
  waitForHealthy,
} from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();

const port = await findFreePort();
const server = await spawnOpencodeServe({ directory, port });

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });
  await waitForHealthy(client);

  const root = "LegalWork Test";
  const nestedDir = path.join(root, "nested");
  const filePath = path.join(root, "hello.txt");

  await mkdir(path.join(directory, nestedDir), { recursive: true });
  await writeFile(path.join(directory, filePath), "legalwork engine test\n", "utf8");

  const entries = (await client.file.list({ location: { directory }, path: root })).data;
  assert.ok(entries.some((entry) => path.basename(entry.path) === "nested" && entry.type === "directory"));
  assert.ok(entries.some((entry) => path.basename(entry.path) === "hello.txt" && entry.type === "file"));

  const read = await client.file.read({ location: { directory }, path: filePath });
  assert.ok(new TextDecoder().decode(read).includes("legalwork engine test"));

  await rm(path.join(directory, root), { recursive: true, force: true });

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: server.baseUrl,
      directory: server.cwd,
      root,
    }),
  );
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(
    JSON.stringify({
      ok: false,
      error: message,
      stderr: server.getStderr(),
      stdout: server.getStdout?.() ?? "",
      serverExit: server.getExitInfo?.() ?? null,
    }),
  );
  process.exitCode = 1;
} finally {
  await server.close();
}
