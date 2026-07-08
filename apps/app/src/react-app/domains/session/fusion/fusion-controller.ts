/**
 * Fusion mode orchestration, modeled on the engine's subagent (task tool)
 * system: the main chat receives one normal prompt, the main model decides
 * when to call task-tool subagents, and the main model owns synthesis.
 *
 * One fusion send:
 * 1. The app sends one normal prompt to the main model.
 * 2. The main model receives Fusion instructions and the normal task-tool
 *    subagent type.
 * 3. The main model calls task-tool subagents when useful, waits on those
 *    outputs, and writes the visible fused
 *    answer in the main session. The differentiated Fusion columns mirror the
 *    resulting task-tool parts.
 */
import type {
  AgentPartInput,
  FilePartInput,
  Message,
  Part,
  TextPartInput,
  ToolPart,
} from "@opencode-ai/sdk/v2/client";

import { unwrap } from "@/app/lib/opencode";
import type { Client, ModelRef } from "@/app/types";
import {
  buildFusionDelegationSystemPrompt,
  isFusionCandidateAgentName,
} from "./fusion-prompt";
import { useFusionStore, type FusionCandidateRun } from "./fusion-store";

const FUSION_TASK_POLL_MS = 1200;
const FUSION_TASK_TIMEOUT_MS = 15 * 60_000;

export type FusionPromptParts = Array<TextPartInput | FilePartInput | AgentPartInput>;

export type RunFusionSendInput = {
  client: Client;
  directory?: string;
  mainSessionId: string;
  parts: FusionPromptParts;
  userText: string;
  /** Candidate models selected for this chat (the fusion subagents). */
  candidateModels: ModelRef[];
  /** The session's main model: converses, routes, and fuses. */
  mainModel?: ModelRef;
  agent?: string;
  variant?: string;
  /** Extra system context (e.g. environment context) prepended to every main-session prompt. */
  baseSystem?: string;
};

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type MessageWithParts = { info: Message; parts: Part[] };

async function listMessages(client: Client, sessionID: string, directory?: string): Promise<MessageWithParts[]> {
  return unwrap(await client.session.messages({ sessionID, directory }));
}

/**
 * Snapshot of the main session at turn start: the text of the last completed
 * assistant message (the fused answer delivered for the previous turn; null
 * on the first turn) and the ids of all existing messages, so the UI can tell
 * which assistant message is this turn's fused answer.
 */
async function readMainSessionBaseline(
  client: Client,
  sessionID: string,
  directory?: string,
): Promise<{ previousFusionText: string | null; baselineMessageIds: string[] }> {
  try {
    const messages = await listMessages(client, sessionID, directory);
    let previousFusionText: string | null = null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.info.role !== "assistant") continue;
      const text = collectText(message.parts);
      if (text.trim()) {
        previousFusionText = text;
        break;
      }
    }
    return { previousFusionText, baselineMessageIds: messages.map((message) => message.info.id) };
  } catch {
    return { previousFusionText: null, baselineMessageIds: [] };
  }
}

async function isSessionBusy(client: Client, sessionID: string, directory?: string): Promise<boolean | null> {
  try {
    const statuses = unwrap(await client.session.status({ directory }));
    const status = statuses[sessionID];
    return status !== undefined && status.type !== "idle";
  } catch {
    return null; // unknown — the caller keeps waiting on message state instead
  }
}

function collectText(parts: Part[]): string {
  return parts
    .flatMap((part) => (part.type === "text" && !part.ignored ? [part.text] : []))
    .join("\n")
    .trim();
}

function fusionTracePrompt(sections: string): string {
  return `The user may be asking about the latest fusion candidate outputs. Answer from this trace when relevant. Do not claim no candidate/subagent/fusion models ran if this trace is present.

## Latest fusion candidate trace

${sections}`;
}

function taskTraceSection(part: ToolPart, index: number): string {
  const input = recordValue(part.state.input);
  const metadata = taskStateMetadata(part);
  const model = taskStateModel(part);
  const modelLabel = model ? `${model.providerID}/${model.modelID}` : stringValue(input, "description") || `Candidate ${index + 1}`;
  const sessionID = stringValue(metadata, "sessionId");
  const status = part.state.status;
  const output =
    part.state.status === "completed"
      ? part.state.output.trim() || "(no output captured)"
      : part.state.status === "error"
        ? `Error: ${part.state.error}`
        : "(still running)";
  return `### Candidate ${index + 1} (${modelLabel})
Status: ${status}${sessionID ? `\nSession: ${sessionID}` : ""}

${output}`;
}

async function buildFusionTraceSystemPrompt(input: {
  client: Client;
  directory?: string;
  sessionId: string;
}): Promise<string | null> {
  const { client, directory, sessionId } = input;
  const turn = useFusionStore.getState().turns[sessionId];
  if (turn && turn.runs.length > 0 && turn.runs.some((run) => run.text.trim() || run.error)) {
    const sections = turn.runs
      .map((run, index) => {
        const output = run.error ? `Error: ${run.error}` : run.text.trim() || "(no output captured)";
        return `### Candidate ${index + 1} (${run.model.providerID}/${run.model.modelID})
Status: ${run.status}

${output}`;
      })
      .join("\n\n");
    return fusionTracePrompt(sections);
  }
  try {
    const taskParts = collectFusionTaskParts(await listMessages(client, sessionId, directory));
    const latest = taskParts.slice(-3);
    if (latest.length === 0) return null;
    return fusionTracePrompt(latest.map(taskTraceSection).join("\n\n"));
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function modelFromRecord(record: Record<string, unknown> | null): ModelRef | null {
  if (!record) return null;
  const providerID = stringValue(record, "providerID");
  const modelID = stringValue(record, "modelID");
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.providerID === right.providerID && left.modelID === right.modelID;
}

function taskInput(part: ToolPart): Record<string, unknown> | null {
  return recordValue(part.state.input);
}

function taskStateMetadata(part: ToolPart): Record<string, unknown> | null {
  if (!("metadata" in part.state)) return null;
  return recordValue(part.state.metadata);
}

function taskStateModel(part: ToolPart): ModelRef | null {
  return modelFromRecord(recordValue(taskStateMetadata(part)?.model));
}

function isFusionTaskPart(part: Part): part is ToolPart {
  if (part.type !== "tool" || part.tool !== "task") return false;
  const input = taskInput(part);
  const subagentType = stringValue(input, "subagent_type");
  if (subagentType && isFusionCandidateAgentName(subagentType)) return true;
  const description = stringValue(input, "description");
  return Boolean(description?.startsWith("Fusion candidate"));
}

function collectFusionTaskParts(messages: MessageWithParts[], baselineMessageIds?: Set<string>): ToolPart[] {
  return messages.flatMap((message) => {
    if (baselineMessageIds?.has(message.info.id)) return [];
    return message.parts.filter(isFusionTaskPart);
  });
}

function taskStatus(part: ToolPart): FusionCandidateRun["status"] {
  if (part.state.status === "completed") return "done";
  if (part.state.status === "error") return "error";
  if (part.state.status === "pending") return "pending";
  return "running";
}

function patchFromTaskPart(part: ToolPart): Partial<FusionCandidateRun> {
  const metadata = taskStateMetadata(part);
  const patch: Partial<FusionCandidateRun> = {
    status: taskStatus(part),
  };
  const model = taskStateModel(part);
  if (model) patch.model = model;
  const sessionID = stringValue(metadata, "sessionId");
  if (sessionID) patch.sessionID = sessionID;
  if (part.state.status === "completed") {
    patch.text = part.state.output.trim();
    patch.error = null;
  }
  if (part.state.status === "error") {
    patch.error = part.state.error;
  }
  return patch;
}

function matchTaskPartsToCandidates(taskParts: ToolPart[], candidateModels: ModelRef[]): Array<ToolPart | null> {
  const matched = new Set<number>();
  return candidateModels.map((model, index) => {
    const byModelIndex = taskParts.findIndex((part, partIndex) => {
      if (matched.has(partIndex)) return false;
      const taskModel = taskStateModel(part);
      return Boolean(taskModel && sameModel(taskModel, model));
    });
    if (byModelIndex >= 0) {
      matched.add(byModelIndex);
      return taskParts[byModelIndex] ?? null;
    }
    if (matched.has(index)) return null;
    const fallback = taskParts[index] ?? null;
    if (fallback) matched.add(index);
    return fallback;
  });
}

function applyFusionTaskProgress(sessionId: string, candidateModels: ModelRef[], taskParts: ToolPart[]): void {
  const updateRun = useFusionStore.getState().updateRun;
  matchTaskPartsToCandidates(taskParts, candidateModels).forEach((part, index) => {
    if (!part) return;
    updateRun(sessionId, index, patchFromTaskPart(part));
  });
}

async function monitorFusionTaskProgress(input: {
  client: Client;
  directory?: string;
  sessionId: string;
  userText: string;
  candidateModels: ModelRef[];
  baselineMessageIds: string[];
  startTurnOnFirstTask: boolean;
}): Promise<void> {
  const { client, directory, sessionId, userText, candidateModels, baselineMessageIds, startTurnOnFirstTask } = input;
  const baseline = new Set(baselineMessageIds);
  const setPhase = useFusionStore.getState().setPhase;
  const deadline = Date.now() + FUSION_TASK_TIMEOUT_MS;
  let turnStarted = Boolean(useFusionStore.getState().turns[sessionId]);

  const ensureTurnStarted = () => {
    if (turnStarted) return;
    useFusionStore.getState().startTurn(sessionId, {
      userText,
      phase: "candidates",
      baselineMessageIds,
      runs: candidateModels.map((model) => ({
        model,
        sessionID: null,
        status: "pending",
        reasoning: "",
        text: "",
        error: null,
      })),
    });
    turnStarted = true;
  };

  while (Date.now() < deadline) {
    await sleep(FUSION_TASK_POLL_MS);
    let taskParts: ToolPart[] = [];
    try {
      taskParts = collectFusionTaskParts(await listMessages(client, sessionId, directory), baseline);
      if (taskParts.length > 0) {
        if (startTurnOnFirstTask) ensureTurnStarted();
        applyFusionTaskProgress(sessionId, candidateModels, taskParts);
        const terminalCount = taskParts.filter((part) => part.state.status === "completed" || part.state.status === "error").length;
        if (terminalCount >= candidateModels.length) setPhase(sessionId, "fusing");
      }
    } catch {
      // transient read failure; the main run continues server-side
    }

    const busy = await isSessionBusy(client, sessionId, directory);
    if (busy === false) {
      let latest = taskParts;
      if (latest.length === 0) {
        try {
          latest = collectFusionTaskParts(await listMessages(client, sessionId, directory), baseline);
        } catch {
          latest = [];
        }
      }
      if (latest.length === 0) {
        if (turnStarted) {
          candidateModels.forEach((_, index) => {
            useFusionStore.getState().updateRun(sessionId, index, {
              status: "error",
              error: "The main agent finished without spawning Fusion task-tool subagents.",
            });
          });
          setPhase(sessionId, "error");
        }
        return;
      }
      if (startTurnOnFirstTask) ensureTurnStarted();
      applyFusionTaskProgress(sessionId, candidateModels, latest);
      setPhase(sessionId, latest.some((part) => part.state.status === "completed") ? "done" : "error");
      return;
    }
  }
  setPhase(sessionId, "error");
}

export async function runFusionSend(input: RunFusionSendInput): Promise<void> {
  const { client, directory, mainSessionId, parts, userText, candidateModels, mainModel, agent, variant, baseSystem } = input;

  const { baselineMessageIds } = await readMainSessionBaseline(client, mainSessionId, directory);

  const store = useFusionStore.getState();
  store.clearTurn(mainSessionId);
  const setPhase = useFusionStore.getState().setPhase;
  const traceSystem = await buildFusionTraceSystemPrompt({ client, directory, sessionId: mainSessionId });

  const fusionSystem = [baseSystem, traceSystem, buildFusionDelegationSystemPrompt({
    candidateModels,
  })]
    .filter((section): section is string => Boolean(section?.trim()))
    .join("\n\n");
  const result = await client.session.promptAsync({
    sessionID: mainSessionId,
    directory,
    parts,
    model: mainModel,
    agent,
    ...(variant ? { variant } : {}),
    system: fusionSystem,
  });
  if (result.error) {
    setPhase(mainSessionId, "error");
    throw new Error(describeError(result.error));
  }
  await monitorFusionTaskProgress({
    client,
    directory,
    sessionId: mainSessionId,
    userText,
    candidateModels,
    baselineMessageIds,
    startTurnOnFirstTask: true,
  });
}
