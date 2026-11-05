import {ensureNativeCatalogReady} from "./opencode-catalog-ready";
import type { QueuedDraftSnapshot } from "@legalwork/types/session-queue";
import { getClientContext, resolveLegalworkWorkspaceMount } from "./opencode";
import { createLegalworkServerClient } from "./legalwork-server";
import type {
  SessionPromptInput,
  ModelRef as NativeModelRef,
  SessionCommandInput,
} from "@opencode/client";
import type { Client, ModelRef } from "../types";
import type { PromptPart, TextPartInput } from "./opencode-view";

async function attachDesktopBrowser(client:Client,sessionId:string) {
  if(typeof window==="undefined")return;
  const context=getClientContext(client),mount=context ? resolveLegalworkWorkspaceMount(context.baseUrl):null;
  if(!mount)return;
  const browser=window.__LEGALWORK_ELECTRON__?.browser;
  // Main verifies session ownership and sandbox policy. Unavailable browser
  // attachment leaves the native tool denied and must not block other work.
  try {
    const registration=context?.auth?.mode==="legalwork" && context.auth.token && browser?.registerConnection
      ? await browser.registerConnection({baseUrl:mount.baseUrl,token:context.auth.token}) : undefined;
    await browser?.attachSession?.({workspaceId:mount.workspaceId,sessionId,directory:context?.directory,connectionId:registration?.connectionId});
  } catch { /* Unavailable or intentionally denied browser does not prevent ordinary chat. */ }
}

/** Per-turn context is ordinary persisted conversation input; never dynamic system text. */
export function systemReminderPart(text: string): TextPartInput {
  return {
    type: "text",
    text: `<system-reminder>\n${text}\n</system-reminder>`,
    synthetic: true,
  };
}
export type PromptIntent = {
  sessionID: string;
  parts: PromptPart[];
  model?: ModelRef;
  agent?: string;
  variant?: string;
  reasoning_effort?: string;
  messageID?: string;
  directory?: string;
  system?: string;
  noReply?: boolean;
  delivery?: "queue" | "steer";
  draft?: QueuedDraftSnapshot;
};
export function buildSessionPromptRequest(
  input: PromptIntent,
  context?: string,
): PromptIntent {
  return {
    ...input,
    parts: context?.trim()
      ? [...input.parts, systemReminderPart(context.trim())]
      : input.parts,
  };
}
export function nativePrompt(input: PromptIntent) {
  const visibleText = input.parts
    .flatMap((part) =>
      part.type === "text" && !part.synthetic && !part.ignored
        ? [part.text]
        : [],
    )
    .join("\n");
  const reminders = input.parts.flatMap((part) =>
    part.type === "text" && part.synthetic ? [part.text] : [],
  );
  if (input.system?.trim())
    reminders.push(systemReminderPart(input.system.trim()).text);
  return {
    sessionID: input.sessionID,
    id: input.messageID,
    text: [visibleText, ...reminders].filter(Boolean).join("\n\n"),
    resume: true,
    delivery: input.delivery,
    files: input.parts.flatMap((part) =>
      part.type === "file" ? [{ uri: part.url, name: part.filename }] : [],
    ),
    agents: input.parts.flatMap((part) =>
      part.type === "agent" ? [{ name: part.name }] : [],
    ),
    skills: input.parts.flatMap((part) =>
      part.type === "skill" ? [{ id: part.id }] : [],
    ),
    metadata: { legalworkPrompt: { visibleText, reminders } },
  } satisfies SessionPromptInput;
}
export function nativeModel(model: ModelRef, variant?: string): NativeModelRef {
  return {
    id: model.modelID,
    providerID: model.providerID,
    ...(variant ? { variant } : {}),
  };
}
export async function selectSessionExecution(
  client: Client,
  sessionID: string,
  options: { model?: ModelRef; variant?: string; agent?: string },
) {
  if (options.model)
    await client.session.switchModel({
      sessionID,
      model: nativeModel(options.model, options.variant),
    });
  if (options.agent)
    await client.session.switchAgent({ sessionID, agent: options.agent });
}
export async function sendSessionPrompt(
  client: Client,
  input: PromptIntent,
  options?: { waitForCompletion?: boolean },
) {
  const context = getClientContext(client);
  const mount =
    context?.auth?.mode === "legalwork"
      ? resolveLegalworkWorkspaceMount(context.baseUrl)
      : null;
  if (mount && context?.auth?.token) {
    const { sessionID, ...payload } = nativePrompt(input);
    const server = createLegalworkServerClient({
      baseUrl: mount.baseUrl,
      token: context.auth.token,
      hostToken: context.auth.hostToken,
    });
    if (input.noReply)
      return server.dispatchSession(mount.workspaceId, sessionID, {
        kind: "synthetic",
        id: payload.id,
        text: payload.text,
        resume: false,
        metadata: { ...payload.metadata, legalworkSystemReminder: true },
        waitForCompletion: options?.waitForCompletion,
      });
    await attachDesktopBrowser(client,sessionID);
    return server.dispatchSession(mount.workspaceId, sessionID, {
      kind: "prompt",
      ...payload,
      model: input.model ? nativeModel(input.model, input.variant) : undefined,
      agent: input.agent,
      waitForCompletion: options?.waitForCompletion,
      draft: input.draft,
    });
  }
  await client.session.update({ sessionID: input.sessionID, archived: false });
  await selectSessionExecution(client, input.sessionID, input);
  const prompt = nativePrompt(input);
  const admitted = input.noReply
    ? await client.session.synthetic({
        sessionID: input.sessionID,
        text: prompt.text,
        resume: false,
        metadata: { legalworkSystemReminder: true },
      })
    : await client.session.prompt(prompt);
  if (options?.waitForCompletion)
    await client.session.wait({ sessionID: input.sessionID });
  return admitted;
}
export async function sendSessionCommand(
  client: Client,
  input: {
    sessionID: string;
    command: string;
    arguments?: string;
    model?: string;
    agent?: string;
    variant?: string;
    parts?: PromptPart[];
    draft?: QueuedDraftSnapshot;
  },
) {
  const separator = input.model?.indexOf("/") ?? -1;
  const model =
    input.model && separator >= 0
      ? {
          providerID: input.model.slice(0, separator),
          modelID: input.model.slice(separator + 1),
        }
      : undefined;
  const context = getClientContext(client);
  const mount =
    context?.auth?.mode === "legalwork"
      ? resolveLegalworkWorkspaceMount(context.baseUrl)
      : null;
  if (mount && context?.auth?.token) {
    const server = createLegalworkServerClient({
      baseUrl: mount.baseUrl,
      token: context.auth.token,
      hostToken: context.auth.hostToken,
    });
    await attachDesktopBrowser(client,input.sessionID);
    return server.dispatchSession(mount.workspaceId, input.sessionID, {
      kind: "command",
      command: input.command,
      args: input.arguments ?? "",
      files: input.parts?.flatMap((part) =>
        part.type === "file" ? [{ uri: part.url, name: part.filename }] : [],
      ),
      model: model ? nativeModel(model, input.variant) : undefined,
      agent: input.agent,
      draft: input.draft,
    });
  }
  await client.session.update({ sessionID: input.sessionID, archived: false });
  await selectSessionExecution(client, input.sessionID, {
    model,
    agent: input.agent,
    variant: input.variant,
  });
  const request: SessionCommandInput = {
    sessionID: input.sessionID,
    name: input.command,
    text: input.arguments ?? "",
    files: input.parts?.flatMap((part) =>
      part.type === "file" ? [{ uri: part.url, name: part.filename }] : [],
    ),
  };
  await client.session.command(request);
}

export function queuedNativePrompt(input: PromptIntent) {
  const { sessionID, id, resume, ...payload } = nativePrompt(input);
  return {
    kind: "prompt" as const,
    ...payload,
    model: input.model ? nativeModel(input.model, input.variant) : undefined,
    agent: input.agent,
  };
}

/** Native IDs survive durable fallback drafts; UI names resolve against the actual workspace catalog. */
export async function resolvePromptSkill(
  client: Client,
  nameOrID: string,
  directory?: string,
): Promise<Extract<PromptPart, { type: "skill" }>> {
  await ensureNativeCatalogReady(client,directory);
  const catalog = await client.skill.list({
    location: directory ? { directory } : undefined,
  });
  const skill =
    catalog.data.find((skill) => skill.id === nameOrID) ??
    catalog.data.find((skill) => skill.name === nameOrID);
  if (!skill) throw new Error(`The selected skill is unavailable: ${nameOrID}`);
  return { type: "skill", id: skill.id };
}
