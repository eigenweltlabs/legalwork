export type CloudAssistantStatus = {
  connected: boolean;
  enabled: boolean;
  state: "off" | "preparing" | "syncing" | "starting" | "enabled" | "error";
  error: string | null;
  accountName: string | null;
};
