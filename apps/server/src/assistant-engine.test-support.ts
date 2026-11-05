import { OpenCode } from "@opencode/client";
import { z } from "zod";
import { assistantEngineClient } from "./assistant-engine.js";

const object = z.record(z.string(), z.unknown());
const objects = z.array(object);
const zeroTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

/** Preserve existing domain scenarios while expressing their fixture records on
 * the native wire. This adapter is test-only; production never speaks v1 HTTP. */
export function nativeAssistantFixture(receive: (request: Request) => Promise<Response> | Response, directory = "/") {
  const directories = new Map<string, string>();
  const selections = new Map<string, { agent?: string; model?: { providerID: string; id: string } }>();
  const session = (value: unknown, id = "fixture") => {
    const data = Array.isArray(value) ? {} : object.parse(value);
    id = typeof data.id === "string" ? data.id : id;
    const location = data.location && typeof data.location === "object" ? z.object({directory:z.string()}).parse(data.location) : {directory: typeof data.directory === "string" ? data.directory : directory};
    directories.set(id, location.directory);
    return { ...data, id, projectID: data.projectID ?? "fixture", cost: data.cost ?? 0, tokens: data.tokens ?? zeroTokens,
      title: data.title ?? id, location,
      time: data.time ?? { created: 1, updated: 1 }, ...(selections.get(id) ?? {}) };
  };
  const message = (value: unknown, index = 0) => {
    const row = object.parse(value), info = object.parse(row.info ?? row), parts = objects.parse(row.parts ?? []);
    const time = object.parse(info.time ?? { created: index + 1 });
    if (info.role === "user") return { id: info.id, type: "user", time,
      text: parts.filter(part => part.type === "text").map(part => part.text).join("\n"),
      metadata: parts.find(part => part.type === "text")?.metadata };
    return { id: info.id, type: "assistant", time, agent: info.agent ?? "legalwork", model: info.model ? { providerID: object.parse(info.model).providerID, id: object.parse(info.model).id ?? object.parse(info.model).modelID } : { providerID: info.providerID ?? "fixture", id: info.modelID ?? "model" },
      tokens: info.tokens ?? zeroTokens, cost: info.cost ?? 0, finish: info.finish,
      ...(info.error ? { error: { type: object.parse(info.error).name, ...object.parse(object.parse(info.error).data ?? {}) } } : {}),
      content: parts.filter(part => !part.synthetic && !part.ignored).flatMap((part, i): object[] => {
        if (part.type === "text" || part.type === "reasoning") return [{ type: part.type, text: part.text, time: part.time }];
        if (part.type !== "tool") return [];
        const state = object.parse(part.state);
        return [{ type: "tool", id: part.callID ?? part.id ?? `tool-${i}`, name: part.tool,
          time: { created: 1, completed: state.status === "completed" ? 2 : undefined },
          state: { ...state, metadata: state.metadata ?? {}, input: state.input ?? {}, content: [{ type: "text", text: state.output ?? state.error ?? "" }] } }];
      }) };
  };
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname;
    if (!path.startsWith("/api/")) return receive(request);
    const selected = path.match(/^\/api\/session\/([^/]+)\/(agent|model)$/);
    if (selected && request.method === "POST") {
      const body = object.parse(await request.json());
      const previous = selections.get(selected[1]) ?? {};
      selections.set(selected[1], { ...previous,
        ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
        ...(body.model ? { model: z.object({ id: z.string(), providerID: z.string() }).parse(body.model) } : {}) });
      return new Response(null, { status: 204 });
    }
    const invoke = async (pathname: string, body?: unknown) => {
      const target = new URL(url); target.pathname = pathname;
      const bodyLocation = body && typeof body === "object" && "location" in body ? z.object({ directory: z.string() }).parse(body.location).directory : undefined;
      const location = url.searchParams.get("location[directory]") ?? bodyLocation ?? directories.get(path.split("/")[3]) ?? directory;
      target.searchParams.set("directory", location);
      const headers = new Headers(request.headers); headers.set("x-opencode-directory", encodeURIComponent(location));
      return receive(new Request(target, { method: request.method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    };
    if (path === "/api/agent") {
      const response = await invoke("/agent"); if (!response.ok) return response;
      return Response.json({ data: objects.parse(await response.json()).map(row => ({ ...row, id: row.id ?? row.name, permissions: row.permissions ?? row.permission ?? [] })) });
    }
    if (path === "/api/location/reload") {
      const response = await invoke("/instance/dispose"); return response.ok ? new Response(null, { status: 204 }) : response;
    }
    if (/^\/api\/session\/[^/]+\/inbox$/.test(path)) return Response.json({data:[]});
    if (path === "/api/session/active") {
      const response = await invoke("/session/status");
      if (!response.ok) return response;
      return Response.json({ data: Object.fromEntries(Object.entries(object.parse(await response.json()))
        .filter(([, value]) => object.parse(value).type !== "idle").map(([id]) => [id, { type: "running" }])) });
    }
    const form = path.match(/^\/api\/session\/([^/]+)\/form(?:\/([^/]+)(\/reply)?)?$/);
    if (form) {
      if (request.method === "POST") {
        const data = z.object({ answer: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])) }).parse(await request.json());
        const response = await invoke(`/question/${form[2]}/reply`, { answers: Object.values(data.answer).map(value => Array.isArray(value) ? value : [String(value)]) });
        return response.ok ? new Response(null, { status: 204 }) : response;
      }
      let response = await invoke(`/api/session/${form[1]}/question`);
      if (response.status === 404) response = await invoke("/question");
      if (!response.ok) return response;
      const value = await response.json();
      const rows = objects.parse(Array.isArray(value) ? value : object.parse(value).data ?? []);
      const data = rows.filter(row => row.sessionID === form[1]).map(row => ({ id: row.id, sessionID: row.sessionID, title: "Question",
        fields: objects.parse(row.questions).map((q, index) => ({ key: `q${index}`, type: q.multiple ? "multiselect" : "string",
          title: q.header ?? "Question", description: q.question, custom: q.custom ?? true,
          options: objects.parse(q.options ?? []).map(option => ({ ...option, value: option.label })) })) }));
      return Response.json({ data: form[2] ? { ...data.find(row => row.id === form[2]), state: { status: "pending" } } : data });
    }
    const permission = path.match(/^\/api\/session\/([^/]+)\/permission/);
    if (permission) {
      const body = request.body ? object.parse(await request.json()) : undefined;
      let response = await invoke(path, body);
      if (response.status === 404) {
        const legacy = body && "decision" in body ? { reply: body.decision } : body;
        response = await invoke(path.replace(/^\/api\/session\/[^/]+\/permission/, "/permission"), legacy);
        if (request.method === "GET" && response.ok) { const rows = objects.parse(await response.json()); return Response.json({ data: rows.filter(row => row.sessionID === permission[1]).map(row => ({ ...row, action: row.action ?? row.permission, resources: row.resources ?? row.patterns })) }); }
      }
      return request.method === "POST" && response.ok ? new Response(null, { status: 204 }) : response;
    }
    if (path === "/api/session") {
      const body = request.body ? object.parse(await request.json()) : undefined;
      const response = await invoke("/session", body); if (!response.ok) return response;
      const data = await response.json();
      return Response.json(request.method === "GET" ? { data: objects.parse(data).map(row => session(row)), cursor: { next: null, previous: null } } : { data: session(data) });
    }
    const prompt = path.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (prompt) {
      const input = z.object({ id: z.string().optional(), text: z.string(), files: z.array(z.object({ uri: z.string(), name: z.string().optional() })).optional(), metadata: object.optional() }).parse(await request.json());
      const selection = selections.get(prompt[1]);
      const visible = z.object({ visibleText: z.string(), reminders: z.array(z.string()) }).optional().parse(input.metadata?.legalworkPrompt);
      const parts = visible ? [
        ...(visible.visibleText ? [{ type: "text", text: visible.visibleText, metadata: input.metadata }] : []),
        ...visible.reminders.map(text => ({ type: "text", text, synthetic: true })),
      ] : [{ type: "text", text: input.text }];
      const response = await invoke(`/session/${prompt[1]}/prompt_async`, { messageID: input.id, agent: selection?.agent,
        ...(selection?.model ? { model: { providerID: selection.model.providerID, modelID: selection.model.id } } : {}), parts });
      if (!response.ok) return response;
      return Response.json({ data: { id: input.id ?? "generated", type: "user", time: { created: 1 }, text: input.text, delivery: "queue" } });
    }
    const history = path.match(/^\/api\/session\/([^/]+)\/message$/);
    if (history) {
      const response = await invoke(`/session/${history[1]}/message`); if (!response.ok) return response;
      const rows = objects.parse(await response.json());
      for (const row of rows) {
        const info = object.parse(row.info ?? row);
        if (info.role === "user" && info.model) { const model = object.parse(info.model); selections.set(history[1], { agent: typeof info.agent === "string" ? info.agent : undefined, model: { providerID: String(model.providerID), id: String(model.modelID) } }); }
      }
      return Response.json({ data: rows.map(message).reverse(), cursor: { next: null, previous: null } });
    }
    const single = path.match(/^\/api\/session\/([^/]+)\/message\/([^/]+)$/);
    if (single) {
      const response = await invoke(`/session/${single[1]}/message/${single[2]}`); if (!response.ok) return response;
      return Response.json({ data: message(await response.json()) });
    }
    const get = path.match(/^\/api\/session\/([^/]+)$/);
    if (get) {
      const response = await invoke(`/session/${get[1]}`, request.body ? await request.json() : undefined); if (response.status === 404) return Response.json({ data: session({ id: get[1] }, get[1]) }); if (!response.ok) return response;
      return request.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json({ data: session(await response.json(), get[1]) });
    }
    if (path.endsWith("/interrupt")) {
      const response = await invoke(path.replace("/api/", "/").replace(/\/interrupt$/, "/abort"));
      return response.ok ? Response.json({ resumed: false }) : response;
    }
    if (path === "/api/model") return Response.json({ data: [] });
    return receive(request);
  };
}

export function createAssistantTestClient(options: { baseUrl: string; directory?: string; fetch?: typeof fetch }) {
  const oldFetch = options.fetch ?? fetch;
  const fixture = nativeAssistantFixture(request => oldFetch(request), options.directory);
  return assistantEngineClient(OpenCode.make({ baseUrl: options.baseUrl,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fixture(new Request(input, init)), { preconnect: fetch.preconnect }),
  }), options.directory ?? "/");
}
