export type CostTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

/** Currencies remain separate; a mixed chat never silently adds EUR to USD. */
export type CostAmount = {
  currency: "USD" | "EUR";
  cost: number | null;
  knownCost: number;
  source: "estimate" | "gateway";
};

export type CostModel = {
  providerId: string;
  modelId: string;
  modelName?: string;
  amounts: CostAmount[];
  calls: number;
  tokens: CostTokens;
};

export type CostUsage = {
  amounts: CostAmount[];
  calls: number;
  unpricedCalls: number;
  pendingCalls: number;
  tokens: CostTokens;
  models: CostModel[];
};

export type PromptCostUsage = CostUsage & {
  messageId: string;
  assistantMessageIds: string[];
};

export type SessionCostSummary = {
  sessionId: string;
  total: CostUsage;
  background: CostUsage;
  delegated: CostUsage;
  prompts: PromptCostUsage[];
};
