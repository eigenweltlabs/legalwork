/**
 * Fusion mode orchestration.
 *
 * One fusion turn:
 * 1. Ensure a hidden child session exists per configured candidate model
 *    (children of the main chat session, reused across turns).
 * 2. Send the user's message to every candidate session in parallel and
 *    stream each one's reasoning/output into the fusion store (rendered as
 *    columns in the chat).
 * 3. Send the user's message to the main session with the fusion system
 *    prompt (carrying all candidate outputs) using the configured fusion
 *    model — its synthesis streams into the chat as the visible answer.
 *
 * Follow-up turns repeat the fan-out on the same candidate sessions; each
 * candidate is told what fused answer was actually delivered for the
 * previous turn so all three chats stay coherent with the main chat.
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
  buildCandidateSystemPrompt,
  buildFusionSystemPrompt,
  type FusionCandidateOutput,
} from "./fusion-prompt";
import { candidateSessionKey, useFusionStore } from "./fusion-store";

const CANDIDATE_POLL_MS = 1200;
const CANDIDATE_TIMEOUT_MS = 15 * 60_000;
/**
 * Grace window after the prompt request settles: prompt_async is expected to
 * resolve when the run completes, but if the server treats it as
 * enqueue-and-return we keep polling until the assistant message reports a
 * completion timestamp.
 */
const COMPLETION_GRACE_MS = 60_000;

export type FusionPromptParts = Array<TextPartInput | FilePartInput | AgentPartInput>;

export type RunFusionTurnInput = {
  client: Client;
  directory?: string;
  mainSessionId: string;
  parts: FusionPromptParts;
  userText: string;
  candidateModels: ModelRef[];
  fusionModel: ModelRef;
  agent?: string;
  /** Extra system context (e.g. environment context) prepended to the fusion system prompt. */
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
 * Text of the last completed assistant message in the main session — the
 * fused answer delivered for the previous turn (null on the first turn).
 */
async function getPreviousFusionText(client: Client, sessionID: string, directory?: string): Promise<string | null> {
  try {
    const messages = await listMessages(client, sessionID, directory);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.info.role !== "assistant") continue;
      const text = collectText(message.parts);
      if (text.trim()) return text;
    }
    return null;
  } catch {
    return null;
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

async function ensureCandidateSession(input: {
  client: Client;
  directory?: string;
  mainSessionId: string;
  model: ModelRef;
}): Promise<string> {
  const { client, directory, mainSessionId, model } = input;
  const key = candidateSessionKey(mainSessionId, model);
  const store = useFusionStore.getState();
  const existing = store.candidateSessionIds[key];
  if (existing) {
    const lookup = await client.session.get({ sessionID: existing, directory });
    if (lookup.data) return existing;
    store.forgetCandidateSession(key);
  }
  const created = unwrap(
    await client.session.create({
      directory,
      parentID: mainSessionId,
      title: `Fusion candidate · ${model.modelID}`,
    }),
  );
  useFusionStore.getState().rememberCandidateSession(key, created.id);
  return created.id;
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

  let promptSettled = false;
  let promptError: unknown = null;
  void client.session
    .promptAsync({ sessionID, directory, parts, model, agent, system })
    .then((result) => {
      promptSettled = true;
      if (result.error) promptError = result.error;
    })
    .catch((error: unknown) => {
      promptSettled = true;
      promptError = error;
    });

  const deadline = Date.now() + CANDIDATE_TIMEOUT_MS;
  let settledAt: number | null = null;
  let latestText = "";

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

    const last = fresh[fresh.length - 1];
    const completed = last?.info.role === "assistant" && typeof last.info.time.completed === "number";
    if (promptSettled && completed) {
      if (!latestText) throw new Error("Model produced no output.");
      return latestText;
    }
    if (promptSettled) {
      settledAt ??= Date.now();
      if (Date.now() - settledAt > COMPLETION_GRACE_MS) {
        if (latestText) return latestText;
        throw new Error("Model produced no output.");
      }
    }
  }
  throw new Error("Timed out waiting for the model to finish.");
}

export async function runFusionTurn(input: RunFusionTurnInput): Promise<void> {
  const { client, directory, mainSessionId, parts, userText, candidateModels, fusionModel, agent, baseSystem } = input;

  const previousFusionText = await getPreviousFusionText(client, mainSessionId, directory);
  const candidateSystem = buildCandidateSystemPrompt(previousFusionText);

  const store = useFusionStore.getState();
  store.startTurn(mainSessionId, {
    userText,
    phase: "candidates",
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
        const sessionID = await ensureCandidateSession({ client, directory, mainSessionId, model });
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
    model: fusionModel,
    agent,
    system: fusionSystem,
  });
  if (result.error) {
    setPhase(mainSessionId, "error");
    throw new Error(describeError(result.error));
  }
  setPhase(mainSessionId, "done");
}
