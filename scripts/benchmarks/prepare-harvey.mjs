import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inside, privateWrite, readJson, sha256 } from "./evidence.mjs";

const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const root = option("--root", process.env.LEGALWORK_BENCH_ROOT);
if (!root) throw new Error("--root is required");
const selection = await readJson(option("--selection", fileURLToPath(new URL("suites/harvey-selection.json", import.meta.url))));
const { repository, commit } = selection.dataset;
if (repository !== "harveyai/harvey-labs" || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Pin the public Harvey repository to an immutable commit");
const headers = { accept: "application/vnd.github+json", "user-agent": "legalwork-real-regression-benchmark", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
const materialized = [];
async function readGitHub(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`, { headers });
  if (!response.ok) throw new Error(`Public benchmark listing HTTP ${response.status}; no file/task was silently skipped`);
  return response.json();
}
async function download(path, destination) {
  const listing = await readGitHub(path);
  for (const file of Array.isArray(listing) ? listing : [listing]) {
    if (file.type === "dir") { await download(file.path, inside(destination, file.name)); continue; }
    if (file.type !== "file") throw new Error(`Unsupported public fixture entry: ${file.path}`);
    const response = await fetch(`https://raw.githubusercontent.com/${repository}/${commit}/${file.path.split("/").map(encodeURIComponent).join("/")}`);
    if (!response.ok) throw new Error(`Public benchmark file HTTP ${response.status}: ${file.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const gitBlob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (gitBlob !== file.sha) throw new Error(`Public fixture integrity mismatch: ${file.path}`);
    await privateWrite(inside(destination, file.name), bytes);
    materialized.push({ source: file.path, bytes: bytes.length, gitBlob, sha256: sha256(bytes) });
  }
}
const tasks = [];
for (const assignment of selection.assignments) {
  if (!/^tasks\/[^/]+\/[^/]+$/.test(assignment.key)) throw new Error("Invalid pinned Harvey task key");
  const directory = inside(root, `harvey/${commit}/${assignment.key}`);
  await download(assignment.key, directory);
  const task = await readJson(join(directory, "task.json"));
  if (typeof task.instructions !== "string" || !Array.isArray(task.criteria)) throw new Error(`Unsupported Harvey task schema: ${assignment.key}`);
  const deliverables = Array.isArray(task.deliverables) ? task.deliverables : Object.keys(task.deliverables);
  tasks.push({
    id: assignment.key.replaceAll("/", "-"),
    source: { repository, commit, task: assignment.key },
    ...(assignment.evaluation ? { evaluation: assignment.evaluation } : {}),
    copyFiles: [{ from: join(directory, "documents"), to: "documents" }],
    prompt: `${task.instructions}\n\nInput documents are in the task folder's documents/ subfolder. Write the following deliverables into the task folder:\n${deliverables.map(name => `- ${name}`).join("\n")}\nWork autonomously using LegalWork's available capabilities.`,
    artifacts: deliverables,
    criteria: task.criteria,
    assertions: [{ id: "engine-completed-without-error", type: "agent.no_error" }, ...deliverables.map(path => ({ id: `deliverable:${path}`, type: "artifact.exists", path }))],
  });
}
const suite = { id: "harvey-legalwork-pinned-v1", model: { providerID: option("--provider", "benchmark"), modelID: option("--model", "Eigenwelt Europe Gemini"), backendModel: option("--backend-model", "gemini-3.8-flash"), ...(option("--variant") ? { variant: option("--variant") } : {}) }, dataset: selection.dataset, coverage: { implemented: ["ten pinned public Harvey legal tasks through real Electron and real engine", "full source documents and criterion-level rubric retained", "saved deliverables and complete traces"], pending: ["rubric judging until separately executed and validated", "live Office behavior and capability suite", "repeat trials/provider/OS matrix"] }, tasks };
await privateWrite(join(root, "harvey-materialization.json"), { source: selection.dataset, files: materialized });
await privateWrite(join(root, "harvey-suite.json"), suite);
console.log(JSON.stringify({ suite: join(root, "harvey-suite.json"), taskCount: tasks.length, files: materialized.length, bytes: materialized.reduce((sum, file) => sum + file.bytes, 0), inferenceCalls: 0 }));
