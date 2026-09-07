import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";

export const APPLE_FM_BASE_URL = "http://127.0.0.1:1976/v1";
export const APPLE_FM_START_COMMAND = "/usr/bin/fm serve --host 127.0.0.1 --port 1976";

/** Explicit opt-in. Use the macOS product version, never Darwin's kernel version. */
export function appleFoundationModelsStatus({ platform, systemVersion, flag, hasCli }) {
  const enabled = flag === "1";
  const major = /^([0-9]+)(?:\.|$)/.exec(systemVersion)?.[1];
  const supported = platform === "darwin" && Number(major) >= 27;
  return {
    available: enabled && supported && hasCli,
    enabled,
    supported,
    hasCli,
    systemVersion,
    baseURL: APPLE_FM_BASE_URL,
    startCommand: APPLE_FM_START_COMMAND,
  };
}

export function hasAppleFoundationModelsCli() {
  try {
    accessSync("/usr/bin/fm", constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function appleFoundationModelsUrl(baseURL) {
  const url = new URL(baseURL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
    throw new Error("Apple Foundation Models must use a local HTTP endpoint ending in /v1.");
  }
  url.pathname = "/v1/models";
  return url;
}

/** Run in the main process: fm serve need not allow browser CORS requests. */
export async function listAppleFoundationModels(status, baseURL, fetchImpl = fetch) {
  if (!status.available) throw new Error("Apple Foundation Models requires the experimental flag, macOS 27 or later, and /usr/bin/fm.");
  const url = appleFoundationModelsUrl(baseURL);
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  } catch {
    throw new Error("Cannot reach fm serve. Start it in Terminal on this Mac and keep it running, then retry.");
  }
  if (!response.ok) throw new Error(`Apple model server returned HTTP ${response.status}. Check Terminal for availability, quota or setup errors.`);
  const payload = await response.json();
  const ids = Array.isArray(payload?.data)
    ? payload.data.flatMap((model) => typeof model?.id === "string" && model.id.trim() ? [model.id] : [])
    : [];
  if (!ids.length) throw new Error("Apple model server returned no model IDs.");
  return [...new Set(ids)];
}

/** Consume genuine Chat Completions SSE, including arguments split across events. */
export async function readAppleToolTestStream(response) {
  if (!response.ok) throw new Error(`Apple model server returned HTTP ${response.status}. Check Terminal for details.`);
  if (!response.body) throw new Error("Apple model server returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let content = "";
  const calls = new Map();
  let finishReason;
  let doneMarker = false;
  const consume = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") { doneMarker = true; return; }
    if (!data) return;
    const event = JSON.parse(data);
    if (event.error) throw new Error("Apple model server reported an error during the tool test. Check Terminal for details.");
    const choice = event.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (typeof delta?.content === "string") content += delta.content;
    for (const call of delta?.tool_calls ?? []) {
      if (!Number.isInteger(call.index)) throw new Error("Apple returned a tool call without a stream index.");
      const assembled = calls.get(call.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) assembled.id = call.id;
      if (call.function?.name) assembled.function.name += call.function.name;
      if (call.function?.arguments) assembled.function.arguments += call.function.arguments;
      calls.set(call.index, assembled);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        consume(pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
      }
      if (doneMarker) break;
      if (done) { if (pending) consume(pending); break; }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!finishReason || !doneMarker) throw new Error("Apple returned an incomplete Chat Completions stream.");
  return { content, toolCalls: [...calls.values()], finishReason };
}

/** A synthetic read-only tool: no user files, shell commands, or model claims accepted. */
export async function testAppleFoundationModelsTools(status, baseURL, model, fetchImpl = fetch) {
  if (!status.available) throw new Error("Apple provider is not available on this Mac.");
  if (typeof model !== "string" || !model.trim() || model.length > 200) throw new Error("Select a model to test.");
  const url = appleFoundationModelsUrl(baseURL);
  url.pathname = "/v1/chat/completions";
  const tools = [{ type: "function", function: {
    name: "legalwork_connection_probe",
    description: "Returns a newly generated connection verification code. Call it to obtain the code; do not invent one.",
    parameters: { type: "object", properties: { request: { type: "string", description: "Use the value verify." } }, required: ["request"], additionalProperties: false },
  } }];
  const messages = [{ role: "user", content: "Call legalwork_connection_probe with request verify. Then return only the exact verification code returned by the tool. You cannot know the code until the tool executes." }];
  const send = async (conversation) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: conversation, tools, tool_choice: "auto", stream: true }),
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
    return readAppleToolTestStream(response);
  };
  const first = await send(messages);
  const call = first.toolCalls[0];
  if (first.finishReason !== "tool_calls" || first.toolCalls.length !== 1 || !call?.id || call.function.name !== "legalwork_connection_probe") {
    throw new Error("Tool test failed: the model did not return a structured tool call. A text claim that it called a tool does not count. This beta may have a broken fm serve tool parser.");
  }
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { throw new Error("Tool test failed: invalid JSON tool arguments."); }
  if (args?.request !== "verify") throw new Error("Tool test failed: incorrect tool arguments.");
  // Generate only after the tool call. The code cannot be guessed from the prompt.
  const code = `LW-${randomBytes(12).toString("hex")}`;
  const second = await send([
    ...messages,
    { role: "assistant", content: first.content || null, tool_calls: first.toolCalls },
    { role: "tool", tool_call_id: call.id, content: code },
  ]);
  if (second.finishReason !== "stop" || second.toolCalls.length || second.content.trim() !== code) {
    throw new Error("Tool test failed: the model did not return the actual tool result correctly.");
  }
  return { model, message: "Passed: streamed tool call, valid arguments, and exact tool result round-trip. Full OpenCode workflows still need testing." };
}

/** One action: reuse/start Apple's service, discover PCC, verify tools, return config. */
export async function connectAppleFoundationModels(status, startServer, fetchImpl = fetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  if (!status.available) throw new Error("Apple Intelligence requires macOS 27 or later with the experiment enabled and fm installed.");
  let models;
  try {
    models = await listAppleFoundationModels(status, APPLE_FM_BASE_URL, fetchImpl);
  } catch {
    await startServer();
    for (let attempt = 0; attempt < 8; attempt++) {
      await pause(1000);
      try {
        models = await listAppleFoundationModels(status, APPLE_FM_BASE_URL, fetchImpl);
        break;
      } catch {
        // The CLI may still be starting or waiting on Apple's first-use setup.
      }
    }
  }
  if (!models) throw new Error("Apple's local service could not start. Check the Terminal window for Apple's required first-use setup, then click Connect again.");
  if (!models.includes("pcc")) throw new Error("Private Cloud Compute is not available from Apple's local service. Check Apple Intelligence availability on this Mac.");
  await testAppleFoundationModelsTools(status, APPLE_FM_BASE_URL, "pcc", fetchImpl);
  return { baseURL: APPLE_FM_BASE_URL, model: "pcc" };
}
