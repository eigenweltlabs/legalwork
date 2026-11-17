import type { OpenCodeClient, SessionInfo, SessionMessageInfo, SessionLogOutput } from "@opencode/client";
import type { CostAmount, CostTokens, CostUsage, SessionCostSummary, PromptCostUsage } from "@legalwork/types/session-cost";
import { getWorkspaceEngineSession, listEngineMessages, listEngineSessions, workspaceEngineLocation } from "./engine-client.js";
import { readGatewayCostRequests, type GatewayCostRequest } from "./gateway-cost-store.js";
import { join } from "node:path";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import type { WorkspaceInfo } from "./types.js";

export type UsageCharge = {
  id: string;
  createdAt?: number;
  promptId: string | null;
  assistantMessageId?: string;
  model?: { providerID: string; id: string };
  costUsd: number | null;
  responseId?: string;
  usageSource?: string;
  gateway?: { costEur: number | null; pending: boolean };
  extraCall?: boolean;
  tokens: CostTokens;
};
export type UsageLedger = {
  id: string;
  parentId?: string;
  costUsd: number;
  tokens: CostTokens;
  charges: UsageCharge[];
  assistantStarts?: { id: string; createdAt: number }[];
  promptStarts?: { id: string; createdAt: number }[];
  links: { sessionId: string; promptId: string | null; createdAt?: number }[];
};

const emptyTokens = (): CostTokens => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
const count = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
const sameTokens = (a: CostTokens, b: CostTokens) => a.input === b.input && a.output === b.output &&
  a.reasoning === b.reasoning && a.cache.read === b.cache.read && a.cache.write === b.cache.write;
const tokenCount = (tokens: CostTokens) => tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
function addTokens(a: CostTokens, b: CostTokens) {
  a.input += b.input; a.output += b.output; a.reasoning += b.reasoning;
  a.cache.read += b.cache.read; a.cache.write += b.cache.write;
}
function remainingTokens(a: CostTokens, b: CostTokens): CostTokens {
  return { input: Math.max(0, a.input - b.input), output: Math.max(0, a.output - b.output), reasoning: Math.max(0, a.reasoning - b.reasoning),
    cache: { read: Math.max(0, a.cache.read - b.cache.read), write: Math.max(0, a.cache.write - b.cache.write) } };
}
const modelKey = (model: { providerID: string; id: string }) => JSON.stringify([model.providerID, model.id]);
function pricedCost(cost: number | undefined, tokens: CostTokens, model: UsageCharge["model"], freeModels: ReadonlySet<string>) {
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return null;
  return cost > 0 || tokenCount(tokens) === 0 || model && freeModels.has(modelKey(model)) ? cost : null;
}
function emptyUsage(): CostUsage {
  return { amounts: [], calls: 0, unpricedCalls: 0, pendingCalls: 0, tokens: emptyTokens(), models: [] };
}
function chargeAmount(charge: UsageCharge): CostAmount {
  if (charge.model?.providerID === "eigenwelt" || charge.gateway) {
    const cost = charge.gateway?.costEur ?? null;
    return { currency: "EUR", cost, knownCost: cost ?? 0 };
  }
  return { currency: "USD", cost: charge.costUsd, knownCost: charge.costUsd ?? 0 };
}
function addAmount(amounts: CostAmount[], amount: CostAmount) {
  const current = amounts.find(item => item.currency === amount.currency);
  if (!current) { amounts.push({ ...amount }); return; }
  current.knownCost += amount.knownCost;
  current.cost = current.cost === null || amount.cost === null ? null : current.cost + amount.cost;
}
function addCharge(usage: CostUsage, charge: UsageCharge) {
  const calls = charge.assistantMessageId || charge.extraCall ? 1 : 0;
  const amount = chargeAmount(charge);
  usage.calls += calls;
  addAmount(usage.amounts, amount);
  if (charge.gateway?.pending) usage.pendingCalls++;
  if (amount.cost === null) usage.unpricedCalls += Math.max(1, calls);
  addTokens(usage.tokens, charge.tokens);
  const providerId = charge.model?.providerID ?? "", modelId = charge.model?.id ?? "";
  let model = usage.models.find(item => item.providerId === providerId && item.modelId === modelId);
  if (!model) { model = { providerId, modelId, amounts: [], calls: 0, tokens: emptyTokens() }; usage.models.push(model); }
  model.calls += calls;
  addAmount(model.amounts, amount);
  addTokens(model.tokens, charge.tokens);
}

/** Match gateway response costs to native usage by provider response ID.
 * OpenCode remains the source of tokens for matched calls. Other captured calls
 * (titles, compaction, retries) remain part of lifetime usage. */
export function applyGatewayCosts(ledger: UsageLedger, requests: readonly GatewayCostRequest[], now = Date.now()): UsageLedger {
  const charges = ledger.charges.map(charge => ({ ...charge }));
  const consumed = new Set<string>();
  const cost = (request?: GatewayCostRequest): NonNullable<UsageCharge["gateway"]> => ({
    costEur: request?.costEur ?? null,
    pending: request !== undefined && request.costEur === undefined && request.completedAt === undefined && now - request.createdAt < 300_000,
  });
  for (const charge of charges) {
    if (charge.model?.providerID !== "eigenwelt") continue;
    const byResponse = requests.find(request => !consumed.has(request.requestId) && request.responseId && request.responseId === charge.responseId);
    // OpenAI-compatible models do not always retain native.responseId. Their
    // assistant is created before HTTP starts; bound matching by the next
    // assistant step, so steering cannot transfer the call to another prompt.
    const started = charge.createdAt;
    const starts = ledger.assistantStarts ?? charges.flatMap(item => item.assistantMessageId && item.createdAt !== undefined ? [{ id: item.assistantMessageId, createdAt: item.createdAt }] : []);
    const nextStep = started === undefined ? undefined : starts.flatMap(item => item.createdAt > started ? [item.createdAt] : []).sort((a, b) => a - b)[0];
    const byStep = started === undefined ? undefined : requests.filter(request => !consumed.has(request.requestId) &&
      request.kind === "primary" && request.modelId === charge.model?.id && request.createdAt >= started &&
      (nextStep === undefined || request.createdAt < nextStep)).sort((a, b) => b.createdAt - a.createdAt)[0];
    const request = byResponse ?? byStep;
    if (request) consumed.add(request.requestId);
    charge.gateway = cost(request);
  }
  for (const request of requests) {
    if (consumed.has(request.requestId)) continue;
    // Usage events lack model IDs. Match each auxiliary event once by kind
    // and exact token buckets; the gateway then supplies its model and price.
    const requestTokens = request.tokens;
    const existing = request.kind !== "primary" && requestTokens ? charges.find(charge => !charge.model &&
      !charge.gateway && charge.usageSource === request.kind && sameTokens(charge.tokens, requestTokens)) : undefined;
    const prompt = request.kind === "title" ? null : ledger.promptStarts?.filter(prompt => prompt.createdAt <= request.createdAt)
      .sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null;
    const update = { model: { providerID: "eigenwelt", id: request.modelId },
      gateway: cost(request), extraCall: true };
    if (existing) Object.assign(existing, update);
    else charges.push({ id: `gateway:${request.requestId}`, createdAt: request.createdAt, promptId: prompt,
      costUsd: 0, tokens: request.tokens ?? emptyTokens(), ...update });
  }
  return { ...ledger, charges };
}

/** Each session total is native lifetime spend, independent of the visible or
 * reverted transcript. Child sessions are added once; a fork is not a child. */
export function buildSessionCostSummary(sessionId: string, ledgers: readonly UsageLedger[]): SessionCostSummary {
  const total = emptyUsage(), background = emptyUsage(), delegated = emptyUsage();
  const prompts = new Map<string, PromptCostUsage>();
  const byId = new Map(ledgers.map(ledger => [ledger.id, ledger]));
  const resolveOwner = (id: string, createdAt?: number, seen = new Set<string>()): string | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const parent = byId.get(byId.get(id)?.parentId ?? "");
    const link = parent?.links.filter(link => link.sessionId === id &&
      (createdAt === undefined || link.createdAt === undefined || link.createdAt <= createdAt))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    if (!link || !parent) return null;
    return parent.id === sessionId ? link.promptId : resolveOwner(parent.id, link.createdAt ?? createdAt, seen);
  };
  const seenSessions = new Set<string>();
  for (const ledger of ledgers) {
    if (seenSessions.has(ledger.id)) continue;
    seenSessions.add(ledger.id);
    const charges = [...new Map(ledger.charges.map(charge => [charge.id, charge])).values()];
    const recorded = emptyUsage();
    for (const charge of charges) addCharge(recorded, charge);
    // Older/imported records may lack a full event log. Keep the native total
    // and expose its unallocated portion as background, never invent a prompt.
    const remainder = remainingTokens(ledger.tokens, recorded.tokens);
    const remainingCost = Math.max(0, ledger.costUsd - charges.reduce((sum, charge) => sum + (charge.costUsd ?? 0), 0));
    const gatewayOnly = charges.length > 0 && charges.every(charge => charge.model?.providerID === "eigenwelt");
    if (remainingCost > 1e-10 || tokenCount(remainder) > 0) charges.push({
      id: `${ledger.id}:unallocated`, promptId: null,
      costUsd: remainingCost > 0 ? remainingCost : null, tokens: remainder,
      ...(gatewayOnly && remainingCost === 0 ? { gateway: { costEur: null, pending: false } } : {}),
    });
    for (const charge of charges) {
      addCharge(total, charge);
      if (ledger.id !== sessionId) addCharge(delegated, charge);
      const promptId = ledger.id === sessionId ? charge.promptId : resolveOwner(ledger.id, charge.createdAt);
      if (!promptId) { addCharge(background, charge); continue; }
      let prompt = prompts.get(promptId);
      if (!prompt) { prompt = { ...emptyUsage(), messageId: promptId, assistantMessageIds: [] }; prompts.set(promptId, prompt); }
      addCharge(prompt, charge);
      if (ledger.id === sessionId && charge.assistantMessageId && !prompt.assistantMessageIds.includes(charge.assistantMessageId)) prompt.assistantMessageIds.push(charge.assistantMessageId);
    }
  }
  return { sessionId, total, background, delegated, prompts: [...prompts.values()] };
}

/** Reconstruct prompt ownership at step START, so steering in the middle of a
 * model call cannot move that call's cost to a later prompt. The durable log
 * also retains charges for messages removed by undo. */
export function sessionCostLedger(session: SessionInfo, messages: readonly SessionMessageInfo[], events: readonly SessionLogOutput[], freeModels: ReadonlySet<string>): UsageLedger {
  const users = new Set(messages.filter(message => message.type === "user").map(message => message.id));
  const models = new Map<string, NonNullable<UsageCharge["model"]>>();
  const owners = new Map<string, string | null>();
  const links = new Map<string, UsageLedger["links"][number]>();
  const toolStarts = new Map<string, number>();
  const stepStarts = new Map<string, number>();
  const charges = new Map<string, UsageCharge>();
  let promptId: string | null = null;
  // Saved messages provide lineage for migrated history and still-running tools.
  for (const message of messages) {
    if (message.type === "user") promptId = message.id;
    if (message.type === "assistant") { owners.set(message.id, promptId); models.set(message.id, message.model); }
  }
  promptId = null;
  for (const event of events) {
    if (event.type === "session.inbox.enqueued" && event.data.item.type === "user") users.add(event.data.inboxID);
    if (event.type === "session.inbox.delivered" && users.has(event.data.inboxID)) promptId = event.data.inboxID;
    if (event.type === "session.step.started") {
      owners.set(event.data.assistantMessageID, promptId); models.set(event.data.assistantMessageID, event.data.model);
      stepStarts.set(event.data.assistantMessageID, event.created);
    }
    if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      if (event.data.cost === undefined && event.data.tokens === undefined) continue;
      const id = event.data.assistantMessageID, tokens = event.data.tokens ?? emptyTokens(), model = models.get(id);
      charges.set(event.id, { id: event.id, createdAt: stepStarts.get(id) ?? event.created, assistantMessageId: id, promptId: owners.get(id) ?? null, model,
        costUsd: pricedCost(event.data.cost, tokens, model, freeModels), tokens });
    }
    if (event.type === "session.usage.recorded") charges.set(event.id, {
      id: event.id, createdAt: event.created, promptId: event.data.source === "compaction" ? promptId : null,
      usageSource: event.data.source, costUsd: pricedCost(event.data.cost, event.data.tokens, undefined, freeModels), tokens: event.data.tokens,
    });
    if (event.type === "session.tool.called") toolStarts.set(event.data.id, event.created);
    if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
      const child = event.data.metadata?.sessionID ?? event.data.metadata?.sessionId;
      if (typeof child === "string") links.set(event.data.id, { sessionId: child,
        promptId: owners.get(event.data.assistantMessageID) ?? null, createdAt: toolStarts.get(event.data.id) ?? event.created });
    }
  }
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "tool" || !["subagent", "task"].includes(part.name) || part.state.status === "streaming") continue;
      const child = part.state.metadata?.sessionID ?? part.state.metadata?.sessionId;
      if (typeof child === "string") links.set(part.id, { sessionId: child,
        promptId: owners.get(message.id) ?? null, createdAt: part.time.created });
    }
  }
  // Imported v1 history has no step log. A fork's copied messages must never
  // become new spend; its native total only reflects work since the fork.
  if (charges.size === 0 && !session.fork && (session.cost > 0 || tokenCount(session.tokens) > 0)) {
    for (const message of messages) {
      if (message.type !== "assistant" || !message.tokens) continue;
      charges.set(message.id, { id: message.id, createdAt: message.time.created, assistantMessageId: message.id, promptId: owners.get(message.id) ?? null,
        model: message.model, costUsd: pricedCost(message.cost, message.tokens, message.model, freeModels), tokens: message.tokens });
    }
  }
  for (const charge of charges.values()) {
    const message = messages.find(message => message.type === "assistant" && message.id === charge.assistantMessageId);
    if (message?.type === "assistant" && typeof message.native?.responseId === "string") charge.responseId = message.native.responseId;
  }
  return { assistantStarts: messages.filter(message => message.type === "assistant").map(message => ({ id: message.id, createdAt: message.time.created })), promptStarts: messages.filter(message => message.type === "user").map(message => ({ id: message.id, createdAt: message.time.created })), id: session.id, parentId: session.parentID, costUsd: count(session.cost), tokens: session.tokens,
    charges: [...charges.values()], links: [...links.values()] };
}

export async function readSessionCosts(client: OpenCodeClient, workspace: WorkspaceInfo, sessionId: string, signal?: AbortSignal, config?: ServerConfig): Promise<SessionCostSummary> {
  // Validate the requested project before reading any history or descendants.
  const root = await getWorkspaceEngineSession(client, workspace, sessionId);
  const catalog = await client.model.list({ location: workspaceEngineLocation(workspace) }, { signal }).catch(() => {
    signal?.throwIfAborted();
    // Saved positive costs remain usable if current model metadata is offline.
    return null;
  });
  // A saved zero on a paid model can predate configured prices. Only explicit
  // free pricing proves that a zero-cost call with tokens was actually free.
  const freeModels = new Set(catalog?.data.filter(model => model.cost.length > 0 && model.cost.every(cost =>
    cost.input === 0 && cost.output === 0 && cost.cache.read === 0 && cost.cache.write === 0,
  )).map(model => modelKey({ providerID: model.providerID, id: model.id })));
  const pending = [root], seen = new Set<string>(), ledgers: UsageLedger[] = [];
  while (pending.length) {
    signal?.throwIfAborted();
    const session = pending.shift();
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    const current = await getWorkspaceEngineSession(client, workspace, session.id);
    const requests = config ? await readGatewayCostRequests(join(runtimeStorageDir(config), "gateway-costs"), session.id) : [];
    const [ledger, children] = await Promise.all([
      readLedger(client, workspace, current, freeModels, signal, requests.map(request => request.requestId)),
      listEngineSessions(client, { parentID: session.id }),
    ]);
    ledgers.push(applyGatewayCosts(ledger, requests));
    pending.push(...children);
  }
  const summary = buildSessionCostSummary(sessionId, ledgers);
  const names = new Map(catalog?.data.map(model => [modelKey({ providerID: model.providerID, id: model.id }), model.name]));
  for (const usage of [summary.total, summary.background, summary.delegated, ...summary.prompts]) {
    for (const model of usage.models) model.modelName = names.get(modelKey({ providerID: model.providerId, id: model.modelId }));
  }
  return summary;
}

// Cache numbers and IDs only. Unchanged long histories need not be downloaded
// again every time an agent in another child session finishes a model call.
const ledgerCache = new Map<string, { signature: string; ledger: UsageLedger }>();
async function readLedger(client: OpenCodeClient, workspace: WorkspaceInfo, session: SessionInfo, freeModels: ReadonlySet<string>, signal?: AbortSignal, gatewayRequestIds: string[] = []) {
  const key = JSON.stringify([workspace.id, workspace.path, session.id]);
  const signature = JSON.stringify([session.cost, session.tokens, session.time.updated, [...freeModels].sort(), gatewayRequestIds]);
  const cached = ledgerCache.get(key);
  if (cached?.signature === signature) return cached.ledger;
  const [messages, events] = await Promise.all([
    listEngineMessages(client, session.id),
    (async () => {
      const events: SessionLogOutput[] = [];
      for await (const event of client.session.log({ sessionID: session.id, follow: false }, { signal })) events.push(event);
      return events;
    })(),
  ]);
  const ledger = sessionCostLedger(session, messages, events, freeModels);
  if (ledgerCache.size >= 64) { const oldest = ledgerCache.keys().next().value; if (oldest) ledgerCache.delete(oldest); }
  ledgerCache.set(key, { signature, ledger });
  return ledger;
}
