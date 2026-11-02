export const MAIN_ASSISTANT_PRESET = 'main-assistant';
export const isMainAssistant = (workspace: { preset?: string }) => workspace.preset === MAIN_ASSISTANT_PRESET;
