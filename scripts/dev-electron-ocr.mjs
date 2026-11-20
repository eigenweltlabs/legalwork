import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

export function ocrDevEnvironment(parent = process.env) {
  const root = path.resolve(parent.LEGALWORK_OCR_DEV_ROOT || path.join(homedir(), ".legalwork/ocr-gateway-dev"));
  const profile = path.join(root, "isolated-electron");
  const config = path.join(profile, "legalwork-dev-data/xdg/config/legalwork");
  const env = { ...parent };
  // A caller may have another dev instance's engine or project overrides set.
  for (const key of ["OPENCODE_DB", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "LEGALWORK_WORKSPACES"]) delete env[key];
  return {
    ...env,
    LEGALWORK_DEV_MODE: "1",
    LEGALWORK_ELECTRON_APP_NAME: "LegalWork OCR Dev",
    LEGALWORK_ELECTRON_APP_IDENTIFIER: "com.eigenweltlabs.legalwork.ocr-dev",
    LEGALWORK_ELECTRON_USERDATA: profile,
    LEGALWORK_DATA_DIR: path.join(root, "orchestrator"),
    LEGALWORK_PROJECT_DATA_DIR: path.join(root, "projects"),
    LEGALWORK_SERVER_CONFIG: path.join(config, "server.json"),
    LEGALWORK_RUNTIME_DB: path.join(config, "runtime.sqlite"),
    LEGALWORK_ENGINE_STORAGE_DIR: config,
    LEGALWORK_DESKTOP_BOOTSTRAP_PATH: path.join(profile, "legalwork-dev-data/home/.config/legalwork/desktop-bootstrap.json"),
    LEGALWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY: "1",
    LEGALWORK_ELECTRON_START_URL: "http://localhost:5177",
    LEGALWORK_ELECTRON_REMOTE_DEBUG_PORT: "0",
    LEGALWORK_WORD_ADDIN: "0",
    PORT: "5177",
  };
}

async function canonical(target) {
  try { return await realpath(target); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(target);
    return parent === target ? target : path.join(await canonical(parent), path.basename(target));
  }
}

export async function assertOcrProjectIsolation(env) {
  const root = await canonical(env.LEGALWORK_PROJECT_DATA_DIR);
  const files = [env.LEGALWORK_SERVER_CONFIG, path.join(env.LEGALWORK_ELECTRON_USERDATA, "legalwork-workspaces.json")];
  for (const file of files) {
    let state;
    try { state = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const projects = (state.workspaces ?? []).filter(item => item.workspaceType !== "remote");
    const folders = [...projects.flatMap(item => [item.path, item.directory, item.contentPath, item.previousPath]), ...(state.authorizedRoots ?? [])];
    for (const folder of folders.filter(Boolean)) {
      const relative = path.relative(root, await canonical(path.resolve(folder)));
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
        throw new Error("OCR Dev contains a project outside its isolated project folder. Choose a fresh LEGALWORK_OCR_DEV_ROOT; do not import another dev profile.");
      }
    }
  }
}

async function main() {
  const env = ocrDevEnvironment();
  await assertOcrProjectIsolation(env);
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", () => reject(new Error("OCR Dev port 5177 is occupied. Stop that OCR instance before starting another.")));
    probe.listen(5177, () => probe.close(resolve));
  });
  console.log(`OCR Dev profile: ${env.LEGALWORK_ELECTRON_USERDATA}`);
  const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@legalwork/desktop", "dev:electron"], { cwd: repoRoot, stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  child.once("error", error => { console.error(error); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
