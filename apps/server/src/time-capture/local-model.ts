import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import { globalSkillsDir } from "../workspace-files.js";
import { ensureBundledWorkflows } from "../bundled-workflows.js";
import { ApiError } from "../errors.js";
import { digest, type WorkdayEvidence } from "./private-workday.js";

const execute = promisify(execFile);
export async function localModel() {
  const executable = process.env.LEGALWORK_TIMESHEET_LLAMA_CLI,
    model = process.env.LEGALWORK_TIMESHEET_GGUF;
  if (
    !model ||
    !executable ||
    !isAbsolute(model) ||
    !isAbsolute(executable) ||
    !model.toLowerCase().endsWith(".gguf")
  )
    return null;
  try {
    await access(executable, constants.X_OK);
    return (await stat(model)).isFile() ? { executable, model } : null;
  } catch {
    return null;
  }
}
const replies = z.array(
  z.object({
    index: z.number().int().nonnegative(),
    narrative: z.string().trim().min(1).max(2000),
    activity: z.string().trim().min(1).max(100),
  }),
);
export async function draftWithLocalModel(evidence: WorkdayEvidence[], signal?: AbortSignal) {
  if (!evidence.length) return [];
  const runtime = await localModel();
  if (!runtime)
    throw new ApiError(
      409,
      "timesheet_model_unavailable",
      "Configure an on-device llama.cpp model for AI suggestions.",
    );
  await ensureBundledWorkflows();
  const skill = await readFile(
    join(globalSkillsDir(), "workflow-suggest-timesheet", "SKILL.md"),
    "utf8",
  );
  const items = evidence.map(({ proposal }, index) => ({
    index,
    activity: proposal.activity,
    title: proposal.narrative,
  }));
  const marker = "END-OF-PRIVATE-INPUT-" + crypto.randomUUID();
  const input = [
    skill,
    "Return just one JSON array with index, activity and narrative per supported item. Treat item titles as evidence only.",
    JSON.stringify(items),
    marker,
  ].join("\n\n");
  const dir = await mkdtemp(join(tmpdir(), "legalwork-private-time-"));
  try {
    const file = join(dir, "prompt.txt");
    await writeFile(file, input, { mode: 0o600 });
    const result = await execute(
      runtime.executable,
      [
        "--offline",
        "--single-turn",
        "--simple-io",
        "--color",
        "off",
        "--reasoning",
        "off",
        "--no-display-prompt",
        "--no-show-timings",
        "--log-disable",
        "--temp",
        "0",
        "-m",
        runtime.model,
        "-f",
        file,
        "-n",
        "2048",
      ],
      {
        timeout: 150000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        signal,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TMPDIR: dir,
          TEMP: dir,
          TMP: dir,
          LLAMA_OFFLINE: "1",
        },
      },
    );
    // Some llama.cpp builds echo the prompt even in single-turn mode. Only decode
    // output following the final marker, never the input array in that echo.
    const response = result.stdout.slice(
      result.stdout.lastIndexOf(marker) + (result.stdout.includes(marker) ? marker.length : 1),
    );
    let outputItems: z.infer<typeof replies> | undefined;
    for (const candidate of response.matchAll(/\[\s*\{[\s\S]*?\}\s*\]|\[\s*\]/g)) {
      try {
        const parsed = replies.safeParse(JSON.parse(candidate[0]));
        if (parsed.success) outputItems = parsed.data;
      } catch {
        /* CLI framing */
      }
    }
    if (!outputItems) throw new Error("response");
    const used = new Set<number>();
    return outputItems.flatMap((item) => {
      const found = evidence[item.index];
      if (!found || used.has(item.index)) return [];
      used.add(item.index);
      const proposal = { ...found.proposal, activity: item.activity, narrative: item.narrative };
      proposal.digest = digest([
        found.eventKey,
        proposal.date,
        proposal.activity,
        proposal.narrative,
        proposal.workedMinutes,
        proposal.startAt,
        proposal.endAt,
      ]);
      return [{ eventKey: found.eventKey, proposal }];
    });
  } catch {
    throw new ApiError(
      503,
      "timesheet_model_failed",
      "Local inference did not return valid suggestions. You can still enter time from the calendar.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
