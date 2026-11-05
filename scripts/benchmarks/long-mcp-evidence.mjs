// Additive assertion: ordinary capability.tool semantics remain unchanged.
export function evaluateLongMcpExecution(assertion, summary) {
  if (typeof assertion.connector !== "string" || typeof assertion.tool !== "string" || !/^[A-Za-z0-9_-]+$/.test(assertion.connector) || !/^[A-Za-z0-9_-]+$/.test(assertion.tool)) throw new Error("Exact MCP connector and tool identities are required");
  const direct = `${assertion.connector}_${assertion.tool}`;
  const child = `${assertion.connector}.${assertion.tool}`;
  const completed = summary.tools.filter(call => call.state?.status === "completed" && !call.state.error && call.state.metadata?.error !== true && (
    call.protocol === "native-v2" ? Array.isArray(call.state.content) && call.state.content.length > 0
      : call.protocol === "legacy-v1" && typeof call.state.output === "string" && call.state.output.length > 0
  ));
  const matches = completed.flatMap(call => {
    if (call.tool === direct) return [{ tool: direct, messageID: call.messageID, callID: call.callID ?? call.id, protocol: call.protocol, path: "direct" }];
    if (call.protocol !== "native-v2" || call.tool !== "execute" || call.state.metadata?.error === true) return [];
    const calls = call.state.metadata?.toolCalls;
    if (!Array.isArray(calls)) return [];
    return calls.filter(item => item.tool === child && item.status === "completed").map(() => ({ tool: child, messageID: call.messageID, callID: call.callID ?? call.id, protocol: call.protocol, path: "code-mode-child" }));
  }).filter(call => typeof call.messageID === "string" && call.messageID.length > 0 && typeof call.callID === "string" && call.callID.length > 0);
  return { passed: matches.length > 0, evidence: { expectedDirect: direct, expectedCodeModeChild: child, completedMatches: matches } };
}
