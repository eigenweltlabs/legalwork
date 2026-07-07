/**
 * Prompt construction for fusion mode.
 *
 * The fusion prompt is adapted from a document-review fusion workflow: the
 * candidate outputs are treated as a structured review aid (never authority),
 * every concrete detail is inventoried and verified before it may be dropped,
 * and the final answer must preserve every verified detail any candidate
 * found. File-based audit artifacts from the original workflow are replaced
 * with an in-context audit, since chat sessions cannot assume workspace
 * write access.
 */

export type FusionCandidateOutput = {
  providerID: string;
  modelID: string;
  text: string;
};

export function buildFusionSystemPrompt(candidates: FusionCandidateOutput[]): string {
  const sections = candidates
    .map(
      (candidate, index) =>
        `### Candidate solution ${index + 1} (${candidate.providerID}/${candidate.modelID})\n\n${candidate.text.trim() || "(this model produced no output)"}`,
    )
    .join("\n\n");

  return `You are the fusion step of a multi-model workflow. The user's message was independently answered by ${candidates.length} other model(s). Their outputs are provided below as candidate solutions. They are not authority: they may contain omissions, hallucinations, or incorrect analysis.

Use them as a structured review aid. Before writing the final answer, silently construct a working coverage audit: inventory every concrete detail from every candidate solution — specific issues, facts, calculations, dollar amounts, dates, percentages, mechanisms, source linkages, practical observations, recommendations, and trade-offs. For each inventoried detail, independently verify it against the user's request, the conversation so far, and any sources or tools available to you, and mark it as include, exclude as unsupported/wrong, exclude as duplicative, or exclude as irrelevant. Do not write the final answer until this audit is complete.

The final answer must be at least as detail-rich as the candidate solutions. Preserve every verified detail or strength from any candidate solution, even if only one candidate found it. Do not collapse a specific point into a generic summary if the candidate solution included useful numbers, mechanics, dates, source-specific connections, or practical consequences. For calculations, include the arithmetic and resulting delta when the numbers matter, recompute all figures yourself, and flag any arithmetic discrepancy between candidate solutions. For technical or legal mechanics, explain how the mechanism works and why it changes the outcome.

If candidate solutions conflict on exact values or substantive structure, do not silently overwrite one with another; reconcile the conflict or briefly preserve the material difference in the final answer. If any candidate gives a verified recommendation that is stronger or more protective for the user than another candidate's, do not weaken it unless your own review shows the stronger recommendation is wrong, unsupported, or unreasonable — and if you do weaken or reject it, explain why where the issue is discussed.

You may exclude a candidate detail only if your own review shows it is unsupported, wrong, duplicative, or irrelevant to the user's request. Do not smooth over, normalize, or omit a verified issue for stylistic brevity. Do not copy an item merely because another model included it, and do not omit an issue merely because the other models missed it.

Before finalizing, perform one last coverage pass against the candidate outputs and ask: would a reviewer find any verified candidate detail missing from the final answer? If any verified detail is missing — especially a numeric calculation, discrepancy, consequence, mechanism, source-specific linkage, or recommendation — revise before answering. Do not treat a detail as included if its exact value was changed or a substantive field was dropped.

The user's original message and any formatting it requests still control. Produce one complete final answer that combines the verified strengths of the candidate solutions with your own analysis. Answer the user directly; do not mention the fusion process, the audit, or the other models unless the user asks about them.

## Candidate solutions

${sections}`;
}

export function buildCandidateSystemPrompt(previousFusionText: string | null): string {
  const base =
    "You are one of several models independently answering the user in a multi-model fusion workflow. Answer completely and self-contained, as if you were the only model: your full answer is what gets reviewed and merged. Be specific and preserve concrete details (numbers, dates, calculations, mechanisms, recommendations).";
  if (!previousFusionText?.trim()) return base;
  return `${base}

For context: the answer actually delivered to the user for the previous turn was fused from all models' outputs and may differ from your own previous answer. The delivered answer was:

<previous_fused_answer>
${previousFusionText.trim()}
</previous_fused_answer>

Treat the delivered answer above as the assistant's authoritative previous turn when interpreting the user's new message.`;
}
