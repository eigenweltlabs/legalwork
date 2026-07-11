/**
 * Prompt construction for fusion mode.
 *
 * The fusion prompt is adapted from a document-review fusion workflow. The
 * main agent remains in charge: it decides when to call normal OpenCode
 * task-tool subagents, then treats their outputs as a structured review aid
 * rather than authority.
 */

export const FUSION_CANDIDATE_AGENT = "fusion-candidate";

export function isFusionCandidateAgentName(name: string): boolean {
  return name === FUSION_CANDIDATE_AGENT;
}

export function buildFusionDelegationSystemPrompt(input: {
  candidateModels: Array<{ providerID: string; modelID: string }>;
}): string {
  const candidates = input.candidateModels
    .map((model, index) => `${index + 1}. ${model.providerID}/${model.modelID}`)
    .join("\n");
  return `Fusion mode is active. You are still the only conversational agent: the user is talking to you, and you own the final answer.

If the latest user message is ordinary conversation, small talk, a clarification, or a meta question about the workflow, answer directly in the main conversation and do not call a Fusion task.

Do not use Fusion for mechanical context gathering. File search, glob/list/read, opening attachments, locating the right document, extracting obvious identifiers, checking whether a file exists, or other short factual/tool steps must happen in the main session first.

Before returning any substantive work product such as a review, memo, draft, clause analysis, risk assessment, recommendation, redline rationale, or legal strategy, you must use Fusion to run the same complete substantive task through three submodels. Then create the final result yourself from those independent candidate outputs. Do not skip this because you can answer the task yourself.

Use Fusion after you have enough context to give the candidates a substantive work order. Fusion is for long-running tasks where multiple models may produce qualitatively different legal or strategic analysis: legal risk review, clause interpretation, drafting strategy, negotiation positions, issue spotting, recommendations, redline rationale, or a difficult comparison. Do not use Fusion for the file search itself.

When delegating, use the normal OpenCode task tool. The only valid Fusion subagent type is:

${FUSION_CANDIDATE_AGENT}

Do not invent numbered or model-specific subagent_type values. In particular, do not use fusion-candidate-1, fusion-candidate-2, or fusion-candidate-3.

The user selected these Fusion candidate models as the comparison set:

${candidates}

Before returning the work product, write one canonical Fusion work order for the full substantive task, then make one task-tool call for each selected candidate model, preferably in parallel in the same assistant step. The task prompt for all three calls must be substantively identical. Do not split the candidates by issue, role, perspective, jurisdiction, risk category, or drafting angle. Use subagent_type ${FUSION_CANDIDATE_AGENT} for every call, and put the candidate number and model label only in the description, for example "Fusion candidate 1 - provider/model".

For every task-tool call:
- Use only the valid subagent_type ${FUSION_CANDIDATE_AGENT}.
- Use the same complete, non-ambiguous work order prompt for each candidate. Include the gathered context, exact file references, relevant excerpts or facts, user constraints, and assumptions.
- Do not send the raw user message to candidate models as chat.
- Do not ask the subagent to find, locate, or identify the file. Give it the file/context you already found and ask for the substantive legal work.
- Tell the subagent not to ask the user questions; if information is missing, it must proceed with conservative assumptions, flag open issues, and produce the best useful answer.

After task outputs return, inventory the concrete useful details from each one before answering. If a task output conflicts with another, reconcile the conflict or preserve the material difference. If a task output asks a clarifying question or says it cannot proceed, do not pass that through to the user; answer the subagent's uncertainty yourself with conservative assumptions, flag the open issue, and still produce the best useful final answer.

The user's original message and formatting requirements still control. Answer the user directly; do not mention the fusion process or the other models unless the user asks about them.`;
}

export function buildCandidateSystemPrompt(previousFusionText: string | null, taskBrief?: string | null): string {
  let prompt =
    "You are a hidden candidate model called by the main assistant in a multi-model fusion workflow. Produce work product for the main assistant to review and merge. Answer completely and self-contained. Be specific and preserve concrete details (numbers, dates, calculations, mechanisms, recommendations). Do not ask the user clarifying questions; the user cannot answer you. If information is missing, proceed with explicit conservative assumptions, flag open issues, and give the best useful answer anyway.";
  if (taskBrief?.trim()) {
    prompt += `

The delegated task from the main assistant:

<task_brief>
${taskBrief.trim()}
</task_brief>`;
  }
  if (previousFusionText?.trim()) {
    prompt += `

For context: the answer actually delivered to the user for the previous turn was fused from all models' outputs and may differ from your own previous answer. The delivered answer was:

<previous_fused_answer>
${previousFusionText.trim()}
</previous_fused_answer>

Treat the delivered answer above as the assistant's authoritative previous turn when interpreting the user's new message.`;
  }
  return prompt;
}
