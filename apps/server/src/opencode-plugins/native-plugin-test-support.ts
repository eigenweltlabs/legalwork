import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import type { OpenCodeContext } from "./office-plugin-shared.js";

type Hook = (event: unknown) => Promise<void> | void;

/** A strict fixture for exercising real Plugin.define setup and native hooks without a model. */
export function nativePluginTestRuntime(directory = "/Users/lawyer/Matter") {
  const hooks = new Map<string, Hook[]>();
  const tools = new Map<string, Info>();
  const histories = new Map<string, unknown[]>();
  const sessions = new Map<string, { agent?: string; metadata?: Record<string, unknown> }>();
  const permissions: unknown[] = [];
  const synthetics: Array<{ sessionID: string; text: string; metadata?: unknown }> = [];
  const prompts: Array<{ sessionID: string; text: string; metadata?: unknown }> = [];
  const streams = new Set<ReadableStreamDefaultController<unknown>>();
  const cleanups: Array<Plugin.Cleanup> = [];
  let syntheticFailure: unknown;
  let mcpStatuses: Record<string, { status: string }> = {};
  let mcpFailure: unknown;
  const mcpRequests: unknown[] = [];
  let permissionHandler: OpenCodeContext["ask"];
  const register = async (name: string, callback: Hook) => {
    hooks.set(name, [...hooks.get(name) ?? [], callback]);
    return { dispose: async () => { hooks.set(name, (hooks.get(name) ?? []).filter(hook => hook !== callback)); } };
  };
  // A fixture implements only the domains exercised here; unexpected accesses fail immediately.
  const editor = new Proxy({} as ToolEditor, {
    get(_target, property) {
      if (property === "add") return (tool: Info) => { tools.set(tool.name, tool); };
      if (property === "get") return (name: string) => tools.get(name);
      if (property === "list") return () => [...tools].map(([id, tool]) => ({ ...tool, id }));
      if (property === "remove") return (name: string) => { tools.delete(name); };
      if (property === "namespace") return () => {};
      throw new Error(`Unexpected native editor operation ${String(property)}`);
    },
  });
  const ctx = new Proxy({} as Plugin.Context, {
    get(_target, property) {
      if (property === "location") return { directory: "/plugin/setup/location" };
      if (property === "session") return {
        get: async ({ sessionID }: { sessionID: string }) => ({ ...sessions.get(sessionID), location: { directory } }),
        context: async ({ sessionID }: { sessionID: string }) => histories.get(sessionID) ?? [],
        hook: (name: string, callback: Hook) => register(`session.${name}`, callback),
        synthetic: async (input: { sessionID: string; text: string; metadata?: unknown }) => {
          if (syntheticFailure) throw syntheticFailure;
          synthetics.push(input);
          const history = histories.get(input.sessionID) ?? [];
          history.push({ type: "synthetic", id: `msg_state_${synthetics.length}`, time: { created: Date.now() }, text: input.text, metadata: input.metadata });
          histories.set(input.sessionID, history);
          return {};
        },
      };
      if (property === "permission") return { hook: (name: string, callback: Hook) => register(`permission.${name}`, callback), assert: async (input: {action: string; resources: readonly string[]; save?: readonly string[]; metadata?: Record<string, unknown>}) => {
        permissions.push(input);
        // The domain test callback models explicit resource asks; wildcard catalog policy
        // is independently asserted by native-tool tests and recorded above.
        if (!(input.resources.length === 1 && input.resources[0] === "*")) await permissionHandler?.({ permission: input.action, patterns: [...input.resources], always: input.save ? [...input.save] : [], metadata: input.metadata ?? {} });
      } };
      if (property === "mcp") return { list: async (input: unknown) => {
        mcpRequests.push(input);
        if (mcpFailure) throw mcpFailure;
        return { location: { directory }, data: Object.entries(mcpStatuses).map(([name, status]) => ({ name, status })) };
      } };
      if (property === "tool") return {
        hook: (name: string, callback: Hook) => register(`tool.${name}`, callback),
        transform: async (callback: (value: ToolEditor) => void) => { callback(editor); return { dispose: async () => {} }; },
      };
      if (property === "shell") return { hook: (name: string, callback: Hook) => register(`shell.${name}`, callback) };
      if (property === "event") return { subscribe: ({ signal }: { signal: AbortSignal }) => {
        let current: ReadableStreamDefaultController<unknown>;
        const finish = () => { streams.delete(current); current.close(); signal.removeEventListener("abort", finish); };
        return new ReadableStream<unknown>({
          start(controller) { current = controller; streams.add(controller); signal.addEventListener("abort", finish, { once: true }); },
          cancel() { streams.delete(current); signal.removeEventListener("abort", finish); },
        });
      } };
      throw new Error(`Unexpected native plugin domain ${String(property)}`);
    },
  });

  return {
    ctx, tools, histories, sessions, permissions, synthetics, prompts, mcpRequests,
    failSynthetic: (error: unknown) => { syntheticFailure = error; },
    mcp: (statuses: Record<string, { status: string }>) => { mcpStatuses = statuses; },
    failMcp: (error: unknown) => { mcpFailure = error; },
    move: (next: string) => { directory = next; },
    permissionHandler: (handler: OpenCodeContext["ask"]) => { permissionHandler = handler; },
    start: async (plugin: Plugin.Plugin) => { const cleanup = await plugin.setup(ctx); if (cleanup) cleanups.push(cleanup); },
    close: async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); },
    hook: async (domain: "session" | "tool" | "shell" | "permission", name: string, event: unknown) => {
      for (const callback of hooks.get(`${domain}.${name}`) ?? []) await callback(event);
      if (domain === "session" && name === "prompt" && event && typeof event === "object") {
        const sessionID: unknown = Reflect.get(event, "sessionID"), prompt: unknown = Reflect.get(event, "prompt");
        const text: unknown = prompt && typeof prompt === "object" ? Reflect.get(prompt, "text") : undefined;
        if (typeof sessionID === "string" && typeof text === "string") {
          const metadata: unknown = Reflect.get(event, "metadata");
          prompts.push({ sessionID, text, metadata });
          const history = histories.get(sessionID) ?? [];
          history.push({ type: "user", id: `msg_user_${prompts.length}`, time: { created: Date.now() }, text, metadata });
          histories.set(sessionID, history);
        }
      }
    },
    event: async (event: unknown) => { for (const stream of streams) stream.enqueue(event); await Bun.sleep(0); },
  };
}

/** Domain assertions call the actual native Tool.Info executors and unwrap their text results. */
export async function nativePluginTools(plugin: Plugin.Plugin, initial: OpenCodeContext = {}) {
  const runtime = nativePluginTestRuntime(initial.directory ?? process.cwd());
  await runtime.start(plugin);
  const tool = Object.fromEntries([...runtime.tools].map(([name, info]) => {
    const executeResult = async (input: unknown = {}, context: OpenCodeContext = initial) => {
      runtime.move(context.directory ?? process.cwd());
      runtime.permissionHandler(context.ask);
      const call = nativeTestInvocation(context.sessionID, context.abort);
      // The engine brands its identifiers; fixtures use the same wire strings.
      return info.execute(input, { ...call, ...(context.agent ? { agent: context.agent } : {}), ...(context.messageID ? { messageID: context.messageID } : {}) } as ToolContext);
    };
    return [name, {description:info.description,input:info.input,executeResult,
    execute: async (input: unknown = {}, context: OpenCodeContext = initial): Promise<string> => {
      const result = await executeResult(input,context);
      if (typeof result.content === "string") return result.content;
      return (result.content ?? []).flatMap(item => item.type === "text" ? [item.text] : []).join("\n");
    },
  }]; }));
  return { tool, runtime, close: runtime.close };
}

export function nativeTestInvocation(sessionID = "ses_word", signal = new AbortController().signal): ToolContext {
  // Native identifiers are branded by the engine; this fixture preserves their wire values.
  return { sessionID, agent: "legalwork", messageID: "msg_test", id: "call_test", signal, progress: async () => {} } as unknown as ToolContext;
}

export function nativeToolBefore(runtime: ReturnType<typeof nativePluginTestRuntime>, tool: string, input: unknown, sessionID = "ses_word") {
  return runtime.hook("tool", "execute.before", {...nativeTestInvocation(sessionID),tool,input});
}

export async function nativeProviderTestFetch(plugin:Plugin.Plugin,receive:(request:Request)=>Promise<Response>){
  const runtime=nativePluginTestRuntime();await runtime.start(plugin);
  const send=Object.assign(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const request=new Request(input,init),event={sessionID:"provider-session",agent:"legalwork",model:{providerID:"fixture",id:"fixture"},kind:"primary",request};
    await runtime.hook("session","http.request",event);return receive(event.request);
  },globalThis.fetch);
  return{runtime,send};
}
