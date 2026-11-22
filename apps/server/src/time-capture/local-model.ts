import type { WorkspaceInfo } from "../types.js";
import { skillPathForScope } from "../skills.js";
import { readProjectDetails } from "../project-store.js";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { globalSkillsDir } from "../workspace-files.js";
import { ensureBundledWorkflows } from "../bundled-workflows.js";
import { ApiError } from "../errors.js";
import { digest } from "./private-workday.js";
import { invalidModelOutput } from "./reconstruct-workday.js";

const execute = promisify(execFile);
export async function localModel() {
  const executable = process.env.LEGALWORK_TIMESHEET_LLAMA_CLI;
  const model = process.env.LEGALWORK_TIMESHEET_GGUF;
  if (!model || !executable || !isAbsolute(model) || !isAbsolute(executable) || !model.toLowerCase().endsWith(".gguf"))
    return null;
  try {
    await access(executable, constants.X_OK);
    const file = await stat(model);
    if (file.isFile()) return { executable, model, fingerprint: digest([executable, model, file.ino, file.mtimeMs, file.size]) };
  } catch {
    // The runtime is unavailable until it is configured or installed.
  }
  return null;
}

export async function workdaySkill(workspace?: WorkspaceInfo) {
  await ensureBundledWorkflows();
  const name = "workflow-suggest-timesheet";
  const projectSkill = workspace && await skillPathForScope(workspace, "project", name);
  let skill: string | undefined;
  if (projectSkill) {
    try { skill = await readFile(projectSkill, "utf8"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  skill ??= await readFile(join(globalSkillsDir(), name, "SKILL.md"), "utf8");
  const instructions = workspace && (await readProjectDetails(workspace.path)).personalizationPrompt;
  return instructions ? skill + "\n\nTimekeeping project instructions:\n" + instructions : skill;
}

export async function generateLocalTimeText(runtime: NonNullable<Awaited<ReturnType<typeof localModel>>>, prompt: string, signal: AbortSignal) {
  const marker = "END-OF-PRIVATE-INPUT-" + crypto.randomUUID();
  const dir = await mkdtemp(join(tmpdir(), "legalwork-private-time-"));
  try {
    const file = join(dir, "prompt.txt");
    await writeFile(file, prompt + "\n\n" + marker, { mode: 0o600 });
    const result = await execute(runtime.executable, [
      "--offline", "--single-turn", "--simple-io", "--color", "off", "--reasoning", "off",
      "--no-display-prompt", "--no-show-timings", "--log-disable", "--temp", "0",
      "-m", runtime.model, "-f", file, "-n", "4096",
    ], {
      timeout: 150_000, maxBuffer: 1024 * 1024, windowsHide: true, signal,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: dir, TEMP: dir, TMP: dir, LLAMA_OFFLINE: "1",
      },
    });
    // Some llama.cpp builds echo the prompt; decode only after the last marker.
    const at = result.stdout.lastIndexOf(marker);
    const response = at < 0 ? result.stdout : result.stdout.slice(at + marker.length);
    const first = response.indexOf("{"), last = response.lastIndexOf("}");
    if (first === -1) throw invalidModelOutput();
    return response.slice(first, last + 1);
  } catch (error) {
    if (signal.aborted || error instanceof ApiError) throw error;
    throw new ApiError(503, "timesheet_model_failed", "The on-device model could not complete the request.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
