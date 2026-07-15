/** @jsxImportSource react */
/**
 * Local / Team scope for the firm-hub surfaces. When a page owns the toggle at
 * the top (e.g. the Integrations page, above the Connectors/Skills/Plugins
 * tabs), it provides this context and the sub-views (mcp-view, skills-view)
 * follow it instead of rendering their own toggle. Standalone pages (the
 * Workflows page) render their own toggle and provide no context.
 */
import { createContext, useContext } from "react";

import { t } from "@/i18n";
import { HubTabs } from "../segmented-tabs";

export type HubScope = "local" | "team";

export const HubScopeContext = createContext<HubScope | null>(null);

/** The externally-controlled scope, or null when the sub-view owns it. */
export function useHubScope(): HubScope | null {
  return useContext(HubScopeContext);
}

/**
 * The Local | Team toggle — the SAME canonical segmented control as the
 * Connectors/Skills/Plugins tabs, so the two never drift in style.
 */
export function HubScopeToggle({
  scope,
  onChange,
}: {
  scope: HubScope;
  onChange: (scope: HubScope) => void;
}) {
  return (
    <HubTabs
      items={[
        { id: "local", label: t("firm_hub.scope_local") },
        { id: "team", label: t("firm_hub.scope_team") },
      ]}
      value={scope}
      onChange={onChange}
    />
  );
}
