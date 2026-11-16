export type CostTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type CostModel = {
  providerId: string;
  modelId: string;
  costUsd: number | null;
  knownCostUsd: number;
  calls: number;
  tokens: CostTokens;
};

export type CostUsage = {
  costUsd: number | null;
  knownCostUsd: number;
  calls: number;
  unpricedCalls: number;
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
