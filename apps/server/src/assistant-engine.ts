import type { OpenCodeClient, SessionMessageInfo, FormInfo } from "@opencode/client";
import { z } from "zod";
import { projectMessage, projectSession } from "./native-shared-values.js";
import type { MessageView, PromptPart } from "@legalwork/types/opencode-view";
import { createEngineClient, listEngineSessions, workspaceEngineLocation } from "./engine-client.js";
import { findApiError } from "./errors.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export type { Part, FilePartInput, TextPartInput } from "@legalwork/types/opencode-view";
export type Session = ReturnType<typeof projectSession>;
type Options = { signal?: AbortSignal; throwOnError?: boolean };
type Model = { providerID: string; modelID: string };
export type Message = MessageView["info"] & {
  parentID?: string;
  error?: { name: string; data: { message: string; statusCode?: number; isRetryable?: boolean } };
};
export type AssistantMessage = Message;
export type UserMessage = Message;
export type EngineMessage = Omit<MessageView, "info"> & { info: Message };

/** Domain projection only: every operation uses the released native v2 client.
 * Native records are retained and all paginated history remains accessible. */
export function assistantEngineClient(native: OpenCodeClient, directory: string) {
  async function result<T>(read: () => Promise<T>, options: Options = {}) {
    try { return { data: await read(), response: new Response(null, { status: 200 }) }; }
    catch (error) {
      if (options.throwOnError) throw error;
      const status = findApiError(error)?.status ?? (error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 502);
      return { data: undefined, response: new Response(null, { status }), error };
    }
  }
  function messages(sessionID: string, records: SessionMessageInfo[]): EngineMessage[] {
    let parentID: string | undefined;
    return records.flatMap(record => {
      if (record.type === "user") parentID = record.id;
      return projectMessage(sessionID, record).map(view => {
        const error = record.type === "assistant" ? record.error : undefined;
        return { ...view, info: { ...view.info, parentID: record.type === "assistant" ? parentID : undefined,
          finish: record.type === "assistant" ? record.finish : undefined,
          error: error ? { name: error.type === "interrupted" ? "MessageAbortedError" : error.status ? "APIError" : error.type,
            data: { message: error.message, ...(error.status ? { statusCode: error.status, isRetryable: error.status === 429 || error.status >= 500 } : {}) } } : undefined } };
      });
    });
  }
  const history = async (sessionID: string, limit?: number, options: Options = {}) => {
    const records: SessionMessageInfo[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await native.message.list({ sessionID, ...(cursor ? { cursor } : { order: "desc" }), limit: 100 }, options);
      records.unshift(...page.data.slice().reverse());
      cursor = page.cursor.next ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error("Native history repeated a page cursor.");
      if (cursor) seen.add(cursor);
      // Read through the human turn boundary so parent identity remains exact,
      // without downloading the rest of a long daily chat for every receipt.
      if (limit !== undefined && records.length >= limit && records.some(record => record.type === "user")) break;
    } while (cursor);
    const session = await native.session.get({ sessionID }, options);
    const projected = messages(sessionID, records).map(message => {
      if (message.info.role !== "user") return message;
      return { ...message, info: { ...message.info, model: { providerID: session.model?.providerID ?? "", modelID: session.model?.id ?? "" } },
        parts: message.parts.map(part => part.type === "text" && message.native?.metadata?.legalworkSystemReminder === true ? { ...part, synthetic: true } : part) };
    });
    return limit === undefined ? projected : projected.slice(-limit);
  };
  const forms = async (sessionID: string) => native.session.form.list({ sessionID });
  const question = (form: FormInfo) => ({ id: form.id, sessionID: form.sessionID,
    questions: form.fields.filter(field => field.type !== "external" && !field.hidden).map(field => ({
      header: field.title ?? form.title, question: field.description ?? field.title ?? form.title,
      options: "options" in field ? field.options?.map(option => ({ label: option.label, description: option.description ?? "" })) ?? [] : [],
      multiple: field.type === "multiselect", custom: !("custom" in field) || field.custom !== false,
    })) });
  const permissions = {
    list: (input: { sessionID: string }, options: Options = {}) => result(async () => ({ data: await native.permission.list(input, options) }), options),
    reply: (input: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" }, options: Options = {}) =>
      result(async () => { await native.permission.reply({ sessionID: input.sessionID, requestID: input.requestID, decision: input.reply }, options); return true; }, options),
  };
  const questions = {
    list: (input: { sessionID: string }, options: Options = {}) => result(async () => ({ data: (await forms(input.sessionID)).map(question) }), options),
    reply: (input: { sessionID: string; requestID: string; questionV2Reply: { answers: string[][] } }, options: Options = {}) => result(async () => {
      const form = await native.session.form.get({ sessionID: input.sessionID, formID: input.requestID }, options);
      const fields = form.fields.filter(field => field.type !== "external" && !field.hidden);
      const answer: Record<string, string | number | boolean | string[]> = {};
      for (const [index, field] of fields.entries()) {
        const values = input.questionV2Reply.answers[index] ?? [];
        if (field.type === "multiselect") answer[field.key] = values;
        else if (field.type === "boolean") answer[field.key] = values[0] === "true";
        else if (field.type === "integer" || field.type === "number") answer[field.key] = Number(values[0]);
        else if (field.type === "string") {
          const selected = field.options?.find(option => option.label === values[0]);
          answer[field.key] = selected?.value ?? values[0] ?? "";
        }
      }
      await native.session.form.reply({ sessionID: input.sessionID, formID: input.requestID, answer }, options);
      return true;
    }, options),
  };
  return {
    native,
    session: {
      get: (input: { sessionID: string }, options: Options = {}) => result(async () => projectSession(await native.session.get(input, options)), options),
      list: (input: { limit?: number; search?: string } = {}, options: Options = {}) => result(async () =>
        (await listEngineSessions(native, { directory, ...input })).map(projectSession), options),
      create: (input: { title?: string; parentID?: string }, options: Options = {}) => result(async () =>
        projectSession(await native.session.create({ ...input, location: { directory } }, options)), options),
      children: (input: { sessionID: string }, options: Options = {}) => result(async () =>
        (await listEngineSessions(native, { directory })).filter(session => session.parentID === input.sessionID).map(projectSession), options),
      status: (_input: object = {}, options: Options = {}) => result(async () =>
        Object.fromEntries(Object.keys(await native.session.active(options)).map(id => [id, { type: "busy" }])), options),
      messages: (input: { sessionID: string; limit?: number }, options: Options = {}) => result(() => history(input.sessionID, input.limit, options), options),
      message: (input: { sessionID: string; messageID: string }, options: Options = {}) => result(async () => {
        const record = await native.session.message.get(input, options);
        const found = messages(input.sessionID, [record])[0];
        if (!found) throw new Error("The native message is not a conversational message.");
        return found;
      }, options),
      todo: (input: { sessionID: string }, options: Options = {}) => result(async () => {
        const records = await history(input.sessionID, undefined, options);
        for (const message of [...records].reverse()) for (const part of [...message.parts].reverse()) {
          if (part.type !== "tool" || part.tool !== "todowrite" || part.state.status !== "completed") continue;
          return z.array(z.object({ id: z.string().optional(), content: z.string(), status: z.string(), priority: z.string().default("medium") }))
            .parse(part.state.metadata.todos ?? JSON.parse(part.state.output));
        }
        return [];
      }, options),
      promptAsync: (input: { sessionID: string; messageID?: string; agent?: string; model?: Model | null; parts: PromptPart[];
        tools?: unknown; system?: unknown; format?: unknown }, options: Options = {}) => result(async () => {
        // Replay of an already admitted item wakes its durable inbox; it never
        // inserts a second user message or mutates the original history.
        if (input.agent) await native.session.switchAgent({ sessionID: input.sessionID, agent: input.agent }, options);
        if (input.model) await native.session.switchModel({ sessionID: input.sessionID, model: { providerID: input.model.providerID, id: input.model.modelID } }, options);
        const files = input.parts.flatMap(part => part.type === "file" ? [{ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }] : []);
        const visibleText = input.parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n");
        const reminders = input.parts.flatMap(part => part.type === "text" && part.synthetic ? [part.text] : []);
        const text = [visibleText, ...reminders].filter(Boolean).join("\n\n");
        const metadata = Object.assign({}, ...input.parts.flatMap(part => part.type === "text" && part.metadata ? [z.record(z.string(), z.json()).parse(part.metadata)] : []));
        const admitted = await native.session.prompt({ sessionID: input.sessionID, ...(input.messageID ? { id: input.messageID } : {}),
          text, metadata: { ...metadata, ...(reminders.length && !visibleText ? { legalworkSystemReminder: true } : {}), legalworkPrompt: { visibleText, reminders } }, ...(files.length ? { files } : {}), delivery: "queue", resume: true }, options);
        if (input.messageID && admitted.id !== input.messageID) throw new Error("Native admission returned a different message identity.");
        return admitted;
      }, options),
      abort: (input: { sessionID: string }, options: Options = {}) => result(async () => { await native.session.interrupt(input, options); return true; }, options),
    },
    // All active interaction records come from the native per-session APIs.
    v2: { session: { permission: permissions, question: questions } },
  };
}

export type AssistantEngineClient = ReturnType<typeof assistantEngineClient>;
export const createAssistantEngineClient = (config: ServerConfig, workspace: WorkspaceInfo) =>
  assistantEngineClient(createEngineClient(config, workspace), workspaceEngineLocation(workspace).directory);
