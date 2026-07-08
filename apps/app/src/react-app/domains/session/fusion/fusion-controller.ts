/**
 * Fusion mode orchestration, modeled on the engine's subagent (task tool)
 * system: hidden child sessions of the main chat run the delegated work,
 * while the main model owns the conversation.
 *
 * One fusion send:
 * 1. Router pass — the MAIN model classifies the message in a hidden child
 *    session (structured output): conversational messages are answered
 *    directly by the main model, with no fan-out.
 * 2. For substantive tasks, the message fans out to the chat's selected
 *    candidate models in parallel — each a reusable child session prompted
 *    with a per-run model override (the same lever the task tool uses) —
 *    and their reasoning/output stream into the chat as columns.
 * 3. The main model then answers the user in the main session under the
 *    fusion system prompt carrying all candidate outputs; its synthesis is
 *    the visible reply.
 *
 * Follow-up tasks reuse the same candidate sessions; each candidate is told
 * what answer was actually delivered previously so all chats stay coherent.
 */
import type {
  AgentPartInput,
  FilePartInput,
  Message,
  Part,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import { unwrap } from "@/app/lib/opencode";
import type { Client, ModelRef } from "@/app/types";
import {
  FUSION_ROUTER_SCHEMA,
  buildCandidateSystemPrompt,
  buildFusionSystemPrompt,
  buildRouterSystemPrompt,
  type FusionCandidateOutput,
} from "./fusion-prompt";
import { candidateSessionKey, useFusionStore } from "./fusion-store";

const CANDIDATE_POLL_MS = 1200;
const CANDIDATE_TIMEOUT_MS = 15 * 60_000;
const ROUTER_POLL_MS = 700;
const ROUTER_TIMEOUT_MS = 90_000;

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

function collectReasoning(parts: Part[]): string {
  return parts
    .flatMap((part) => (part.type === "reasoning" ? [part.text] : []))
    .join("\n")
    .trim();
}

async function ensureChildSession(input: {
  client: Client;
  directory?: string;
  mainSessionId: string;
  key: string;
  title: string;
}): Promise<string> {
  const { client, directory, mainSessionId, key, title } = input;
  const store = useFusionStore.getState();
  const existing = store.candidateSessionIds[key];
  if (existing) {
    const lookup = await client.session.get({ sessionID: existing, directory });
    if (lookup.data) return existing;
    store.forgetCandidateSession(key);
  }
  const created = unwrap(
    await client.session.create({ directory, parentID: mainSessionId, title }),
  );
  useFusionStore.getState().rememberCandidateSession(key, created.id);
  return created.id;
}

type RouterDecision = { task: boolean; brief: string | null };

function parseRouterDecision(structured: unknown, text: string): RouterDecision | null {
  let candidate = structured;
  if (candidate === undefined || candidate === null) {
    try {
      candidate = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as { task?: unknown; brief?: unknown };
  if (typeof record.task !== "boolean") return null;
  return {
    task: record.task,
    brief: typeof record.brief === "string" && record.brief.trim() ? record.brief.trim() : null,
  };
}

/**
 * Router pass: the main model classifies the message as a substantive task
 * (delegate to fusion subagents) or conversational (answer directly), via a
 * hidden child session with structured output. When the router cannot decide
 * (error, timeout, unparseable output), the message is treated as a task —
 * the user turned fusion on expecting the fan-out.
 */
async function classifyMessage(input: {
  client: Client;
  directory?: string;
  mainSessionId: string;
  mainModel?: ModelRef;
  userText: string;
  previousFusionText: string | null;
}): Promise<RouterDecision> {
  const { client, directory, mainSessionId, mainModel, userText, previousFusionText } = input;
  try {
    const sessionID = await ensureChildSession({
      client,
      directory,
      mainSessionId,
      key: `${mainSessionId}|fusion-router`,
      title: "Fusion router",
    });
    const before = new Set((await listMessages(client, sessionID, directory)).map((message) => message.info.id));

    let promptError: unknown = null;
    void client.session
      .promptAsync({
        sessionID,
        directory,
        parts: [{ type: "text", text: userText }],
        model: mainModel,
        system: buildRouterSystemPrompt(previousFusionText),
        format: { type: "json_schema", schema: { ...FUSION_ROUTER_SCHEMA }, retryCount: 2 },
      })
      .then((result) => {
        if (result.error) promptError = result.error;
      })
      .catch((error: unknown) => {
        promptError = error;
      });

    const deadline = Date.now() + ROUTER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(ROUTER_POLL_MS);
      if (promptError) break;
      let fresh: MessageWithParts[] = [];
      try {
        const messages = await listMessages(client, sessionID, directory);
        fresh = messages.filter((message) => message.info.role === "assistant" && !before.has(message.info.id));
      } catch {
        continue;
      }
      const last = fresh[fresh.length - 1];
      if (!last || last.info.role !== "assistant" || typeof last.info.time.completed !== "number") continue;
      const parsed = parseRouterDecision(last.info.structured, collectText(last.parts));
      if (parsed) return parsed;
      break;
    }
  } catch {
    // fall through to the task default
  }
  return { task: true, brief: null };
}

async function runCandidate(input: {
  client: Client;
  directory?: string;
  sessionID: string;
  parts: FusionPromptParts;
  model: ModelRef;
  agent?: string;
  system: string;
  onProgress: (reasoning: string, text: string) => void;
}): Promise<string> {
  const { client, directory, sessionID, parts, model, agent, system, onProgress } = input;

  const before = new Set((await listMessages(client, sessionID, directory)).map((message) => message.info.id));

  // prompt_async may either enqueue-and-return or resolve when the run
  // completes, so its resolution only signals errors; run completion is
  // detected from the session's own status and message state below.
  let promptError: unknown = null;
  void client.session
    .promptAsync({ sessionID, directory, parts, model, agent, system })
    .then((result) => {
      if (result.error) promptError = result.error;
    })
    .catch((error: unknown) => {
      promptError = error;
    });

  const deadline = Date.now() + CANDIDATE_TIMEOUT_MS;
  let latestText = "";
  let sawActivity = false;

  while (Date.now() < deadline) {
    await sleep(CANDIDATE_POLL_MS);
    if (promptError) throw new Error(describeError(promptError));

    let fresh: MessageWithParts[] = [];
    try {
      const messages = await listMessages(client, sessionID, directory);
      fresh = messages.filter((message) => message.info.role === "assistant" && !before.has(message.info.id));
    } catch {
      continue; // transient read failure; the prompt keeps running server-side
    }

    latestText = fresh.map((message) => collectText(message.parts)).filter(Boolean).join("\n\n");
    const reasoning = fresh.map((message) => collectReasoning(message.parts)).filter(Boolean).join("\n\n");
    onProgress(reasoning, latestText);

    const busy = await isSessionBusy(client, sessionID, directory);
    if (busy === true || fresh.length > 0) sawActivity = true;
    if (!sawActivity || busy !== false) continue;

    // Session is idle again after having worked: the run is over once the
    // last assistant message reports completion.
    const last = fresh[fresh.length - 1];
    const completed = last?.info.role === "assistant" && typeof last.info.time.completed === "number";
    if (!completed) continue;
    if (!latestText) throw new Error("Model produced no output.");
    return latestText;
  }
  throw new Error("Timed out waiting for the model to finish.");
}

export async function runFusionSend(input: RunFusionSendInput): Promise<void> {
  const { client, directory, mainSessionId, parts, userText, candidateModels, mainModel, agent, variant, baseSystem } = input;

  const { previousFusionText, baselineMessageIds } = await readMainSessionBaseline(client, mainSessionId, directory);

  const decision = await classifyMessage({ client, directory, mainSessionId, mainModel, userText, previousFusionText });
  if (!decision.task) {
    // Conversational message: the main model answers directly, no fan-out.
    const result = await client.session.promptAsync({
      sessionID: mainSessionId,
      parts,
      model: mainModel,
      agent,
      ...(variant ? { variant } : {}),
      ...(baseSystem ? { system: baseSystem } : {}),
    });
    if (result.error) throw new Error(describeError(result.error));
    return;
  }

  const candidateSystem = buildCandidateSystemPrompt(previousFusionText, decision.brief);

  const store = useFusionStore.getState();
  store.startTurn(mainSessionId, {
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
  const updateRun = useFusionStore.getState().updateRun;
  const setPhase = useFusionStore.getState().setPhase;

  const results = await Promise.allSettled(
    candidateModels.map(async (model, index): Promise<FusionCandidateOutput> => {
      try {
        const sessionID = await ensureChildSession({
          client,
          directory,
          mainSessionId,
          key: candidateSessionKey(mainSessionId, model),
          title: `Fusion candidate · ${model.modelID}`,
        });
        updateRun(mainSessionId, index, { sessionID, status: "running" });
        const text = await runCandidate({
          client,
          directory,
          sessionID,
          parts,
          model,
          agent,
          system: candidateSystem,
          onProgress: (reasoning, progressText) => {
            updateRun(mainSessionId, index, { reasoning, text: progressText });
          },
        });
        updateRun(mainSessionId, index, { status: "done", text });
        return { providerID: model.providerID, modelID: model.modelID, text };
      } catch (error) {
        updateRun(mainSessionId, index, { status: "error", error: describeError(error) });
        throw error;
      }
    }),
  );

  const outputs = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (outputs.length === 0) {
    setPhase(mainSessionId, "error");
    const firstFailure = results.find((result) => result.status === "rejected");
    throw new Error(
      `All fusion models failed${firstFailure ? `: ${describeError(firstFailure.reason)}` : "."}`,
    );
  }

  setPhase(mainSessionId, "fusing");
  const fusionSystem = [baseSystem, buildFusionSystemPrompt(outputs)]
    .filter((section): section is string => Boolean(section?.trim()))
    .join("\n\n");
  const result = await client.session.promptAsync({
    sessionID: mainSessionId,
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
  setPhase(mainSessionId, "done");
}
