import { expect, test } from "bun:test";
import { ASSISTANT_BROWSER_AGENT, assistantBrowserModel } from "../assistant-browser.js";
import { registerAssistantBrowserPolicy } from "./assistant-browser-policy.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";

const terra = { providerID: "eigenwelt", id: "gpt-6.1-terra", capabilities: { input: ["text"] } };
const cheap = { ...terra, id: "cheap" };
const settings = { systemPromptAddition: "", resourceIds: [], projectAccess: { mode: "all", projectIds: [] } };

test("browser default prefers subscription Terra and explicit selections never fall back", () => {
  expect(assistantBrowserModel([cheap, terra], undefined)).toBe(terra);
  expect(assistantBrowserModel([{ ...terra, id: "alias", name: "GPT-6.1 Terra" }], null).id).toBe("alias");
  expect(() => assistantBrowserModel([cheap], null)).toThrow("No default browser model is available");
  expect(() => assistantBrowserModel([terra], { providerID: "missing", modelID: terra.id })).toThrow("selected browser model is unavailable");
  expect(assistantBrowserModel([cheap, terra], { providerID: terra.providerID, modelID: terra.id })).toBe(terra);
});

test("browser default recognizes the connected EU catalogue without selecting older Terra models", () => {
  const eu = { providerID: "eigenwelt", id: "Eigenwelt Europe GPT Terra", modelID: "Eigenwelt Europe GPT Terra", name: "GPT-6.1 Terra (EU)" };
  const older = ["gpt-5.6-terra", "gpt-5.6-terra-fast"].map(id => ({ providerID: "openai", id }));
  expect(assistantBrowserModel([...older, cheap, eu], null)).toBe(eu);
  expect(() => assistantBrowserModel(older, null)).toThrow("No default browser model is available");
});

test("browser default accepts Terra service labels without matching unsupported model versions", () => {
  for (const name of ["GPT-6.1 Terra Fast", "GPT-6.1 Terra Fast (EU)", " GPT-6.1 Terra (EU) "]) {
    const model = { providerID: "eigenwelt", id: "alias", name };
    expect(assistantBrowserModel([model], null)).toBe(model);
  }
  for (const name of ["GPT-5.6 Terra (EU)", "GPT-6.10 Terra", "GPT-6.1 Terra Mini", "GPT-6.1 Terra-like", "Claude Sonnet 5", "Gemini 3.8 Flash Lite", "Gemini 4 Argonaut"]) {
    expect(() => assistantBrowserModel([{ providerID: "eigenwelt", id: "alias", name }], null)).toThrow("No default browser model is available");
  }
});

const defaults = [
  ["gpt-6.1-terra", "GPT-6.1 Terra"], ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"], ["gpt-6.1-sol", "GPT-6.1 Sol"],
  ["claude-opus-5-5", "Claude Opus 5.5"], ["gemini-4-argon", "Gemini 4 Argon"],
  ["gpt-6-luna", "GPT-6 Luna"], ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["glm-5.3-flash", "GLM 5.3 Flash"], ["mistral-large-4", "Mistral Large 4"],
];

test("automatic browser selection uses the approved order regardless of catalog order or aliases", () => {
  for (const aliases of [false, true]) {
    const models = defaults.map(([id, name]) => ({ providerID: "eigenwelt", id: aliases ? `subscription-${id}` : id, ...(aliases ? { name: `${name} (EU)` } : {}) }));
    for (let index = 0; index < models.length; index++) {
      expect(assistantBrowserModel(models.slice(index).reverse(), null)).toBe(models[index]);
    }
  }
});

test("automatic selection stays within the subscription and prefers an available EU variant", () => {
  const ownTerra = { ...terra, providerID: "openai" };
  const us = { providerID: "eigenwelt", id: "Eigenwelt US Claude Sonnet", name: "Claude Sonnet 5.5 (US)" };
  const eu = { ...us, id: "Eigenwelt Europe Claude Sonnet", name: "Claude Sonnet 5.5 (EU)" };
  expect(assistantBrowserModel([ownTerra, us, eu], null)).toBe(eu);
  expect(assistantBrowserModel([ownTerra, us], null)).toBe(us);
  expect(() => assistantBrowserModel([ownTerra], null)).toThrow("No default browser model is available");
  expect(assistantBrowserModel([ownTerra, us], { providerID: ownTerra.providerID, modelID: ownTerra.id })).toBe(ownTerra);
  expect(assistantBrowserModel([cheap, terra], { providerID: cheap.providerID, modelID: cheap.id })).toBe(cheap);
});

test("native browser dispatch and worker guards use the same available fallback", async () => {
  const runtime = nativePluginTestRuntime("/Assistant");
  const sonnet = { ...terra, id: "claude-sonnet-5-5" };
  const flash = { ...terra, id: "gemini-3.8-flash" };
  runtime.models([flash, sonnet]);
  runtime.sessions.set("coordinator", { agent: "legalwork", model: cheap });
  runtime.sessions.set("worker", { agent: ASSISTANT_BROWSER_AGENT, parentID: "coordinator", model: sonnet });
  await registerAssistantBrowserPolicy(runtime.ctx, async () => true, async () => ({ settings }));
  const event = { ...nativeTestInvocation("coordinator"), tool: "subagent", input: { agent: ASSISTANT_BROWSER_AGENT } };
  await runtime.hook("tool", "execute.before", event);
  expect(event.input).toMatchObject({ model: "eigenwelt/claude-sonnet-5-5", background: true });
  await runtime.hook("session", "context", { sessionID: "worker", agent: ASSISTANT_BROWSER_AGENT, model: sonnet });
  await runtime.hook("tool", "execute.before", { ...nativeTestInvocation("worker"), tool: "browser.snapshot", input: {} });
  runtime.models([flash]);
  await expect(runtime.hook("session", "context", { sessionID: "worker", agent: ASSISTANT_BROWSER_AGENT, model: sonnet })).rejects.toThrow("configured Browser model");
});

test("Assistant browser work is isolated, model-pinned and cannot bring tabs to the foreground", async () => {
  const runtime = nativePluginTestRuntime("/Assistant");
  runtime.models([cheap, terra]);
  runtime.sessions.set("coordinator", { agent: "legalwork", model: cheap });
  runtime.sessions.set("worker", { agent: ASSISTANT_BROWSER_AGENT, parentID: "coordinator", model: terra });
  runtime.sessions.set("research", { agent: "general", parentID: "coordinator", model: cheap });
  await registerAssistantBrowserPolicy(runtime.ctx, async directory => directory === "/Assistant", async () => ({ settings }));
  const before = async (session: string, tool: string, input: Record<string, unknown> = {}) => {
    const event = { ...nativeTestInvocation(session), tool, input };
    await runtime.hook("tool", "execute.before", event);
    return event.input;
  };
  for (const tool of ["browser.tabs.open", "browser_tabs_open", "browser.snapshot", "legalwork_browser_open_url", "mcp_browser_click", "legalwork_webfetch", "legalwork_websearch", "webfetch", "websearch"])
    await expect(before("coordinator", tool)).rejects.toThrow("Delegate browser work");
  await expect(before("research", "browser.navigate")).rejects.toThrow("Delegate browser work");
  await expect(before("coordinator", "legalwork_ui_execute_action", { actionId: "browser.open_url" })).rejects.toThrow("Delegate browser work");
  expect(await before("coordinator", "subagent", { agent: ASSISTANT_BROWSER_AGENT, model: "fixture/cheap", prompt: "Read the page", background: false }))
    .toMatchObject({ model: "eigenwelt/gpt-6.1-terra", prompt: "Read the page", background: true });
  expect(await before("worker", "browser.tabs.open", { url: "https://example.org", focus: true })).toMatchObject({ focus: false });
  expect(await before("worker", "browser_tabs_open", { focus: true })).toEqual({ focus: false });
  await expect(before("worker", "browser_tabs_focus")).rejects.toThrow("background");
  await expect(before("worker", "browser_preview")).rejects.toThrow("background");
  expect(await before("worker", "legalwork_browser_open_url", { url: "https://example.org", show: true })).toMatchObject({ show: false });
  expect(await before("worker", "legalwork_ui_execute_action", { actionId: "browser.open_url", args: { show: true, url: "https://example.org" } }))
    .toMatchObject({ args: { show: false, url: "https://example.org" } });
  await expect(before("worker", "browser.tabs.select")).rejects.toThrow("background");
  await expect(before("worker", "browser.preview", { path: "report.pdf" })).rejects.toThrow("background");
  expect(await before("coordinator", "read", { path: "notes.md" })).toEqual({ path: "notes.md" });
  expect(await before("coordinator", "subagent", { agent: "general" })).toEqual({ agent: "general" });
  runtime.models([cheap]);
  await expect(before("coordinator", "subagent", { agent: ASSISTANT_BROWSER_AGENT })).rejects.toThrow("No default browser model is available");
  runtime.move("/Other project");
  expect(await before("coordinator", "browser.tabs.open", { focus: true })).toEqual({ focus: true });
});

test("a worker started on the wrong model is refused before generation or browser execution", async () => {
  const runtime = nativePluginTestRuntime("/Assistant");
  runtime.models([cheap, terra]);
  runtime.sessions.set("worker", { agent: ASSISTANT_BROWSER_AGENT, parentID: "coordinator", model: cheap });
  await registerAssistantBrowserPolicy(runtime.ctx, async () => true, async () => ({ settings }));
  await expect(runtime.hook("session", "context", { sessionID: "worker", agent: ASSISTANT_BROWSER_AGENT, model: cheap })).rejects.toThrow("configured Browser model");
  await expect(runtime.hook("tool", "execute.before", { ...nativeTestInvocation("worker"), tool: "browser.snapshot", input: {} })).rejects.toThrow("not using the selected browser model");
});
