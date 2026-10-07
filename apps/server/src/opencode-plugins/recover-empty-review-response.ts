import type { Event, createOpencodeClient } from "@opencode-ai/sdk";

type Client = ReturnType<typeof createOpencodeClient>;

/** One recovery per user request, only for a reasoning-only normal stop during
 * unfinished review work. Never recover errors, cancellations or budget stops. */
export function recoverEmptyReviewResponse(client: Client, directory?: string) {
  const recovering = new Set<string>();
  const retried = new Map<string, string>();
  const reviewSessions = new Set<string>();
  return async ({ event }: { event: Event }) => {
    if (event.type === "message.part.updated") {
      const part = event.properties.part;
      if (part.type === "tool" && part.tool.startsWith("legalwork_review_") && part.state.status === "completed") reviewSessions.add(part.sessionID);
      return;
    }
    if (event.type === "session.deleted") {
      reviewSessions.delete(event.properties.info.id);
      retried.delete(event.properties.info.id);
      return;
    }
    const sessionId = event.type === "session.idle" ? event.properties.sessionID
      : event.type === "session.status" && event.properties.status.type === "idle" ? event.properties.sessionID : null;
    if (!sessionId || recovering.has(sessionId)) return;
    recovering.add(sessionId);
    try {
      const query = { directory };
      const response = await client.session.messages({ path: { id: sessionId }, query: { ...query, limit: 10 } });
      const messages = response.data;
      const last = messages?.at(-1);
      if (!last || last.info.role !== "assistant" || last.info.finish !== "stop" || last.info.error || last.info.summary) return;
      if (!last.parts.some(part => part.type === "reasoning" && part.text.trim())) return;
      if (last.parts.some(part => part.type === "tool" || (part.type === "text" && part.text.trim()))) return;
      // Long workflows have many assistant/tool messages between the request
      // and this stop. Fetch the parent directly if it is outside this page.
      const user = messages?.slice().reverse().find(message => message.info.role === "user")
        ?? (await client.session.message({ path: { id: sessionId, messageID: last.info.parentID }, query })).data;
      if (!user || user.info.role !== "user" || last.info.parentID !== user.info.id) return;
      // Skip system-written turns such as this recovery prompt. A human turn may
      // still carry synthetic app-state reminders next to the user's own text.
      if (user.parts.some(part => part.type === "compaction") || !user.parts.some(part => part.type === "text" && !part.synthetic)) return;
      if (retried.get(sessionId) === user.info.id) return;
      const hasReview = (items: typeof messages) => items?.some(message => message.parts.some(part => part.type === "tool" && part.tool.startsWith("legalwork_review_")));
      if (!reviewSessions.has(sessionId) && !hasReview(messages)) {
        // After an engine reload the in-memory history is empty. Inspect a
        // bounded saved page once; live tool events cover longer workflows.
        const history = await client.session.messages({ path: { id: sessionId }, query: { ...query, limit: 100 } });
        if (!hasReview(history.data)) return;
        reviewSessions.add(sessionId);
      }
      const todos = await client.session.todo({ path: { id: sessionId }, query });
      if (!todos.data?.some(todo => todo.status === "in_progress" || todo.status === "pending")) return;
      // Recheck after reads: new human input or a restart takes precedence.
      const current = await client.session.messages({ path: { id: sessionId }, query: { ...query, limit: 1 } });
      if (current.data?.at(-1)?.info.id !== last.info.id) return;
      const status = await client.session.status({ query });
      if (status.data?.[sessionId]?.type !== "idle") return;
      retried.set(sessionId, user.info.id);
      await client.session.promptAsync({ path: { id: sessionId }, query, body: {
        agent: user.info.agent, model: user.info.model,
        parts: [{ type: "text", synthetic: true, text: "The previous response stopped with reasoning only, without an answer or tool call. Continue the already-authorised unfinished review tasks from their saved state. Reuse existing reviews; do not rerun completed inference. Complete the requested deliverables or explain a concrete blocker." }],
      } });
    } catch {
      // Recovery is optional; never hide the original stop or create a retry loop.
    } finally {
      recovering.delete(sessionId);
    }
  };
}
