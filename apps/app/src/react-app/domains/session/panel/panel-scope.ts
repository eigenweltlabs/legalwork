/** Workflow libraries own their tabs independently of the selected project's workbench. */
export function workflowsPanelKey(workspaceId: string) { return `workflows:${workspaceId}`; }

/** These workspaces keep inactive editors mounted, including unsaved Office documents. */
export function isWorkspacePanelScope(scope: string) {
  return scope.startsWith("workspace:") || scope.startsWith("workflows:") || scope.startsWith("timekeeping:");
}
