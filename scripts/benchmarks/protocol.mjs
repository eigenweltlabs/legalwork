// Meter copies only. The capture proxy forwards original request/response bytes.
export function responseUsage(text, protocol) {
  const records = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    try { records.push(JSON.parse(data || frame)); } catch { /* Keep malformed/opaque frames in raw evidence. */ }
  }
  const usage = {};
  const errors = [];
  let complete = false;
  const models = new Set();
  for (const record of records) {
    for (const model of [record.model, record.message?.model, record.response?.model]) if (typeof model === "string") models.add(model);
    if (record.error) errors.push(record.error);
    if (protocol === "anthropic") {
      Object.assign(usage, record.message?.usage, record.usage);
      if (record.type === "message_stop" || record.type === "message") complete = true;
    } else {
      if (record.usage) Object.assign(usage, record.usage);
      if (record.object === "chat.completion" || record.type === "response.completed") complete = true;
      if (record.response?.usage) Object.assign(usage, record.response.usage);
    }
  }
  if (text.includes("data: [DONE]")) complete = true;
  const native = protocol === "anthropic";
  const input = native ? usage.input_tokens : usage.prompt_tokens ?? usage.input_tokens;
  const output = native ? usage.output_tokens : usage.completion_tokens ?? usage.output_tokens;
  return { raw: Object.keys(usage).length ? usage : null, reportedModels: [...models], input: input ?? null, output: output ?? null, cacheRead: usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? null, cacheWrite: usage.cache_creation_input_tokens ?? usage.prompt_tokens_details?.cache_write_tokens ?? null, reasoning: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? null, complete, errors };
}
