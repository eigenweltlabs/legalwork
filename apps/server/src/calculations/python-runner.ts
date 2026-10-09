import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { listSkills } from "../skills.js";
import { composedSkill } from "../skill-composition.js";
import { ApiError } from "../errors.js";
import { CalculationStepSchema } from "./schema.js";
import type { CalendarStore } from "../calendar/store.js";
import { zoneValid } from "../calendar/dates.js";
import { VmSandbox } from "../agent-sandbox/vm.js";

const calculationSandbox = new VmSandbox();

// Single-file, standard-library contract. Labels are skill-authored; values and code come from execution.
const runner = String.raw`
import contextlib, copy, inspect, io, json, runpy, sys
class Recorder:
    def __init__(self): self.steps = []
    def step(self, title, reason, fn, *args, **kwargs):
        bound = inspect.signature(fn).bind(*args, **kwargs)
        inputs = copy.deepcopy(dict(bound.arguments))
        result = fn(*args, **kwargs)
        lines, line = inspect.getsourcelines(fn)
        self.steps.append(dict(title=title, reason=reason, inputs=inputs, output=copy.deepcopy(result), code="".join(lines), line=line))
        return result
payload = json.load(sys.stdin)
recorder = Recorder()
with contextlib.redirect_stdout(io.StringIO()):
    module = runpy.run_path(sys.argv[1])
    result = module["calculate"](payload, recorder)
print(json.dumps(dict(result=result, steps=recorder.steps, runtime=sys.version.split()[0]), allow_nan=False))
`;
const OutputSchema = z.object({ runtime: z.string(), steps: z.array(CalculationStepSchema).max(100), result: z.object({
  status: z.enum(["calculated", "needs_information", "requires_specialist_review"]),
  results: z.array(z.object({ title: z.string().min(1), date: z.iso.date(), cutoff: z.iso.datetime({ offset: true }), timeZone: z.string() })).max(30).default([]),
  missingFacts: z.array(z.string()).max(30).default([]), sources: z.array(z.string()).max(40).default([]),
}) });
export async function calculationScript(workspace: string, name: string) {
  const composed = await composedSkill(workspace, name);
  const installed = (await listSkills(workspace, true)).find(skill => skill.name === name);
  if (!installed) throw new ApiError(422, "deadline_skill_missing", "Install the calculation skill first.");
  const path = join(dirname(installed.path), "resources", "calculation.py");
  let code: string;
  try { code = await readFile(path, "utf8"); } catch { throw new ApiError(422, "calculation_code_missing", "This skill needs resources/calculation.py implementing calculate(inputs, recorder)."); }
  if (code.length > 200_000) throw new ApiError(422, "calculation_code_large", "Calculation script exceeds 200 KB.");
  return { path, code, composed };
}
export async function executePython(code: string, input: Record<string, unknown>, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-calculation-"));
  try {
    const path = join(directory, "calculation.py");
    await writeFile(path, code);
    await writeFile(join(directory, "runner.py"), runner);
    await writeFile(join(directory, "input.json"), JSON.stringify(input));
    const execution = await calculationSandbox.run({
      command: "python3 -I /workspace/runner.py /workspace/calculation.py < /workspace/input.json",
      cwd: "/workspace", mounts: [{ source: directory, target: "/workspace", writable: false }],
      timeoutMs: 15000, signal: signal ?? new AbortController().signal, networkMode: "block",
      authorizeNetwork: async () => false,
    });
    if (execution.exitCode !== 0 || execution.truncated) {
      throw new ApiError(422, "calculation_failed", `Protected calculation failed: ${execution.output.slice(-2000)}`);
    }
    const output = execution.output;
    const parsed = OutputSchema.parse(JSON.parse(output));
    if (parsed.result.status === "calculated" ? !parsed.result.results.length : parsed.result.results.length > 0 || !parsed.result.missingFacts.length) throw new ApiError(422, "calculation_result", "Missing-information results must have no date; calculated results need at least one date.");
    if (parsed.result.results.some(result => !zoneValid(result.timeZone))) throw new ApiError(422, "calculation_result", "Use a valid IANA time zone.");
    return parsed;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function runPythonCalculation(store: CalendarStore, projectId: string, skill: string, script: Awaited<ReturnType<typeof calculationScript>>, input: Record<string, unknown>, signal?: AbortSignal) {
  const { steps, result, runtime } = await executePython(script.code, input, signal);
  const codeHash = createHash("sha256").update(script.code).digest("hex"), version = `python-trace-v1/Python ${runtime}; ` + script.composed.chain.map(item => `${item.name}@${item.hash.slice(0, 12)}`).join(", ");
  const results = result.results.map(result => {
    const receipt = store.recordCalculation(projectId, { skill, version, rule: result.title, input,
      deadlineDay: result.date, cutoff: result.cutoff, timeZone: result.timeZone, trace: steps.map(step => `${step.title}: ${step.reason} → ${JSON.stringify(step.output)}`), sources: [] }, codeHash);
    return { ...result, calculationId: receipt.id };
  });
  return store.recordRun(projectId, { id: randomUUID(), skill, version, codeHash, code: script.code, createdAt: new Date().toISOString(), origin: "skill",
    inputs: input, status: result.status, steps, results, missingFacts: result.missingFacts, sources: result.sources });
}
