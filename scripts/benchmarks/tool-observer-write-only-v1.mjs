import { createWriteOnlyToolJournal } from "./write-only-tool-journal.mjs";
export default async ({ directory }) => {
  const journal = await createWriteOnlyToolJournal({ socketPath: process.env.LEGALWORK_BENCH_TOOL_SOCKET,
    healthPath: process.env.LEGALWORK_BENCH_TOOL_HEALTH, location: directory, runtimeKind: "legacy-v1" });
  return {
    "tool.execute.before": (input, output) => journal.before({ ...input, input: output.args, id: input.callID }),
    "tool.execute.after": (input, output) => journal.after({ ...input, input: input.args, id: input.callID,
      status: output === undefined ? "unavailable" : "completed", result: output,
      resultAvailability: output === undefined ? "v1-after-hook-provided-no-value" : "complete-v1-hook-value" }),
  };
};
