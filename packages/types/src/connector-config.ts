export type ConnectorConfig = {
  type: "remote" | "local";
  url?: string;
  command?: string[];
  cwd?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
  oauth?: { clientId?: string; clientSecret?: string; scope?: string; callbackPort?: number; redirectUri?: string } | false;
  timeout?: number;
};

/** Read-only connection metadata. Saved executable values and credentials are
 * deliberately absent; submitting this view must never replace a definition. */
export type ConnectorDisplayItem = {
  name: string;
  source: "config.project" | "config.global" | "config.remote";
  editable: boolean;
  disabledByTools?: boolean;
  config: Pick<ConnectorConfig, "type" | "enabled" | "timeout" | "oauth">;
  configured: {
    url: boolean;
    command: boolean;
    cwd: boolean;
    headers: string[];
    environment: string[];
    oauth: boolean;
    variables: string[];
  };
};

/** Omitted values keep the server's saved definition. Removal is explicit. */
export type ConnectorEditRemovals = {
  removeHeaders?: string[];
  removeEnvironment?: string[];
  resetFields?: Array<"cwd" | "timeout" | "oauth">;
};

export type ConnectorConfigEdit = ConnectorEditRemovals & { variables?: Record<string, string>; executable?: string; arguments?: string[] };

/** Imported templates and native engine environment references both need setup before hot-add. */
const variablePattern = /\$\{([^}]+)\}|\{env:([^}]+)\}/g;
export function connectorConfigVariables(config: unknown): string[] {
  const variables = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") for (const match of value.matchAll(variablePattern)) variables.add(match[1] ?? match[2]);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(config);
  return [...variables];
}

export function connectorUsesOAuth(config: ConnectorConfig): boolean {
  if (config.type !== "remote" || config.oauth === false) return false;
  if (config.oauth) return true;
  return !Object.keys(config.headers ?? {}).some(isCredentialHeader);
}

export function isCredentialHeader(name: string): boolean {
  return /^(authorization|(?:x-)?(?:api-)?key|x-auth-token)$/i.test(name);
}

export function resolveConnectorConfig(config: ConnectorConfig, values: Record<string, string>): ConnectorConfig {
  const replace = (value: string) => value.replace(variablePattern, (_, template: string | undefined, environment: string | undefined) => {
    const name = template ?? environment ?? "";
    const answer = values[name];
    if (!answer?.trim()) throw new Error(`Missing value for ${name}`);
    return answer;
  });
  const map = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).map(([key, text]) => [key, replace(text)]));
  return {
    ...config,
    ...(config.url !== undefined ? { url: replace(config.url) } : {}),
    ...(config.cwd !== undefined ? { cwd: replace(config.cwd) } : {}),
    ...(config.command ? { command: config.command.map(replace) } : {}),
    ...(config.headers ? { headers: map(config.headers) } : {}),
    ...(config.environment ? { environment: map(config.environment) } : {}),
    ...(config.oauth ? { oauth: { ...config.oauth,
      ...(config.oauth.clientId ? { clientId: replace(config.oauth.clientId) } : {}),
      ...(config.oauth.clientSecret ? { clientSecret: replace(config.oauth.clientSecret) } : {}),
      ...(config.oauth.scope ? { scope: replace(config.oauth.scope) } : {}),
      ...(config.oauth.redirectUri ? { redirectUri: replace(config.oauth.redirectUri) } : {}),
    } } : {}),
  };
}
