import { AssistantSubmitInputSchema, type AssistantSubmitInput, type LauncherOutputIntent } from "@legalwork/types/launcher";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { DraftCoordinator, type LauncherDraft } from "./draft-coordinator";
import { createSubmissionIdentity } from "./submission-identity";

const submitting = new WeakMap<DraftCoordinator, Set<string>>();

export function validateAssistantMessageText(text: string) {
  if (text.length > 60_000) throw new Error("Messages can contain up to 60,000 characters.");
}

/** Every Assistant surface sends and retries the same frozen operation. */
export async function submitAssistantDraft(options: {
  client: Pick<LegalworkServerClient, "submitAssistantMessage">;
  drafts: DraftCoordinator; conversationId: string; owner: string;
  input: Omit<AssistantSubmitInput, "requestId" | "messageId">; retry?: true | { requestId: string; messageId: string };
  outputIntent?: Pick<LauncherOutputIntent, "output" | "originId">;
  beforeSend?: (input: AssistantSubmitInput, outputIntent?: Pick<LauncherOutputIntent, "output" | "originId">) => Promise<void>;
  identity?: { requestId: string; messageId: string };
  preserveDraft?: boolean;
  draftSnapshot?: Pick<LauncherDraft, "text" | "context">;
}) {
  const { drafts, conversationId } = options;
  const inFlight = submitting.get(drafts) ?? new Set<string>();
  if (inFlight.has(conversationId)) throw new Error("The previous message is still sending. Wait before sending another message.");
  submitting.set(drafts, inFlight);
  inFlight.add(conversationId);
  try {
    return await dispatchAssistantDraft(options);
  } finally {
    inFlight.delete(conversationId);
  }
}

async function dispatchAssistantDraft(options: Parameters<typeof submitAssistantDraft>[0]) {
  const { client, drafts, conversationId, owner } = options;
  if (!options.retry) validateAssistantMessageText(options.input.text);
  await drafts.flush();
  await drafts.reconcile();
  if (!drafts.owns(conversationId, owner)) throw new Error("Focus this conversation before sending; it is being edited in another window.");
  return drafts.protect(conversationId, owner, async () => {
    const draft = drafts.get(conversationId);
    const pending = draft.submission;
    if (!options.retry && pending?.input && ["sending", "unconfirmed"].includes(pending.state))
      throw new Error("The previous message is awaiting confirmation. Retry it before sending another message.");
    if (options.retry && (!pending?.input || (options.retry !== true &&
      (pending.requestId !== options.retry.requestId || pending.messageId !== options.retry.messageId)))) {
      throw new Error("That message is no longer available to retry.");
    }
    const retrying = Boolean(options.retry && pending?.input);
    const reuse = retrying && pending?.state !== "failed";
    const candidate = retrying && pending?.input ? pending.input : options.input;
    validateAssistantMessageText(candidate.text);
    const input = AssistantSubmitInputSchema.parse(reuse && pending?.input ? pending.input : { ...candidate, ...(options.identity ?? createSubmissionIdentity()) });
    const draftSnapshot = retrying ? pending?.draftSnapshot : options.preserveDraft ? undefined : options.draftSnapshot ?? { text: draft.text, context: draft.context };
    const outputIntent = retrying ? pending?.outputIntent : options.outputIntent;
    const operation = { requestId: input.requestId, messageId: input.messageId, input, draftSnapshot, ...(outputIntent ? { outputIntent } : {}) };
    await drafts.update(conversationId, owner, { submission: { ...operation, state: "sending" } });
    // Record automatic output before dispatch, using the exact frozen identity.
    try { await options.beforeSend?.(input, outputIntent); }
    catch (error) {
      // A failed local preparation must not turn an already dispatched retry
      // into a new identity: its earlier delivery may still have succeeded.
      await drafts.update(conversationId, owner, { submission: { ...operation, state: reuse && pending ? pending.state : "failed" } });
      throw error;
    }
    try {
      const { submission } = await client.submitAssistantMessage(conversationId, input);
      await drafts.acknowledgeSubmission(conversationId, owner, submission);
      return submission;
    } catch (error) {
      const refused = error instanceof Error && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status < 500 && error.status !== 408;
      await drafts.update(conversationId, owner, { submission: { ...operation, state: refused ? "failed" : "unconfirmed" } }).catch(() => undefined);
      throw error;
    }
  });
}
