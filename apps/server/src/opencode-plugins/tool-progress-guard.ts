import { toolValidationFeedback } from "./tool-validation-feedback.js";

export type ToolAttempt = {
  id: string; sessionID: string; messageID: string; tool: string; input: unknown; error?: string;
};
type FailureRun = {
  fingerprint: string; count: number; seen: Set<string>; stopped: boolean; latest: ToolAttempt;
  warningMessageID?: string; recoverySteps: Set<string>;
  rendered?: string;
};
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, ordered(entry)]));
  return value;
}
function fingerprint(tool: string, input: unknown) { return JSON.stringify([tool, ordered(input)]); }

/** Give correction guidance before stopping. Parallel calls in one assistant
 * step count as one recovery attempt; successful work resets the guard. */
export function toolProgressGuard(stop: (sessionID: string, reason: string, messageID: string) => Promise<void>) {
  const feedback = toolValidationFeedback();
  const runs = new Map<string, FailureRun>();
  return {
    definition: feedback.definition,
    reset(sessionID: string) { runs.delete(sessionID); },
    async observe(attempt: ToolAttempt) {
      if (attempt.error === undefined) { runs.delete(attempt.sessionID); return; }
      const error = attempt.error.split("\n\n[LegalWork tool recovery]")[0];
      attempt = { ...attempt, error };
      const guidance = feedback.failure(attempt.tool, attempt.input, error);
      if (!guidance) { runs.delete(attempt.sessionID); return; }
      const key = fingerprint(attempt.tool, attempt.input);
      let run = runs.get(attempt.sessionID);
      if (!run || run.fingerprint !== key) {
        run = { fingerprint: key, count: 0, seen: new Set(), stopped: false, recoverySteps: new Set(), latest: attempt };
        runs.set(attempt.sessionID, run);
      }
      if (run.stopped || run.seen.has(attempt.id)) return;
      run.latest = attempt;
      run.rendered = undefined;
      run.seen.add(attempt.id);
      run.count++;
      if (!run.warningMessageID || run.warningMessageID === attempt.messageID) return;
      run.recoverySteps.add(attempt.messageID);
      if (run.recoverySteps.size < 3) return;
      run.stopped = true;
      await stop(attempt.sessionID, `Stopped because identical invalid calls to ${attempt.tool} continued for three assistant steps after correction guidance. ${guidance}`, attempt.messageID);
    },
    guidance(sessionID: string, callID?: string) {
      const run = runs.get(sessionID);
      if (!run || (callID !== undefined && run.latest.id !== callID)) return;
      if (run.rendered !== undefined) return run.rendered;
      const attempt = run.latest;
      const original = (attempt.error ?? "").split("\n\n[LegalWork tool recovery]")[0];
      const hint = feedback.failure(attempt.tool, attempt.input, original);
      if (!hint) return;
      const warning = run.recoverySteps.size === 2
        ? "Final warning: one retry remains. If the next call uses the same tool and arguments and fails validation again, LegalWork will forcibly stop this run. Correct the arguments, choose another approach, or explain what information is missing."
        : run.count >= 3
          ? `The same tool and arguments have failed repeatedly. Repeating this call cannot succeed. Change the arguments, choose another approach, or explain what information is missing. This run will stop only if the same invalid call continues for ${run.recoverySteps.size === 0 ? "three" : "two"} further assistant steps without progress.`
          : "Correct these arguments before retrying.";
      run.rendered = original + `\n\n[LegalWork tool recovery]\n${warning}\n${hint}`;
      return run.rendered;
    },
    /** Rendering happens before persistence; only model-facing admission starts
     * the warning's retry allowance. Historical warnings cannot admit a new run. */
    delivered(sessionID: string, callID: string, text: string) {
      const run = runs.get(sessionID);
      if (!run || run.latest.id !== callID || !run.rendered || !text.includes(run.rendered)) return;
      if (run.count >= 3 && !run.warningMessageID) run.warningMessageID = run.latest.messageID;
    },
  };
}
