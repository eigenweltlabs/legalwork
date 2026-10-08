/**
 * The firm's Knowledge Hub as this computer follows it (apps/server/src/firm-hub.ts):
 * what the admin installed for everyone, and what the firm offers members to
 * add. LegalWork copies none of it into the member's own config; it installs
 * and updates the items and takes them away when the admin does.
 */
export type FirmHubKind = "mcp" | "skill" | "workflow" | "review_set";

/** How members get into a connector the firm gives them. */
export type FirmHubAccess = "none" | "firm" | "member" | "oauth";

export type FirmHubItem = {
  id: string;
  kind: FirmHubKind;
  name: string;
  description: string;
  /** Installed for everyone, or offered for members to add. */
  installation: "automatic" | "optional";
  /** The member added it (an offered one); one installed for everyone is always in. */
  added: boolean;
  /**
   * A connector, once it is on this computer: the name the engine runs it
   * under, its address (a server on the web), how members get in, and
   * whether this member's own key is in.
   */
  connector?: { serverName: string; url: string | null; access: FirmHubAccess; keyName: string | null; hasOwnKey: boolean };
};

export type FirmHubView = {
  /** Signed in to a firm with a hub: otherwise there is nothing. */
  connected: boolean;
  items: FirmHubItem[];
};
