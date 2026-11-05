export type ConnectorCategory = "popular" | "communication" | "files" | "legal" | "practice" | "productivity" | "eigenwelt";
export const connectorCategories: ConnectorCategory[] = ["popular", "communication", "files", "legal", "practice", "productivity", "eigenwelt"];

/** Categories describe the user's work, independent of the connection mechanism. */
export function connectorCategory(id: string, name: string): Exclude<ConnectorCategory, "popular"> {
  const value = `${id} ${name}`.toLowerCase();
  if (/legalmemory|open.?computer.?use|legalwork/.test(value)) return "eigenwelt";
  if (/gmail|outlook|calendar|slack|teams|mail|whatsapp|zoom/.test(value)) return "communication";
  if (/drive|sharepoint|dropbox|\bbox\b|egnyte|storage|datasite|imanage|netdocuments|file-system/.test(value)) return "files";
  if (/beck|juris|westlaw|lexis|legal.?data|midpage|descrybe|court|patent|vlex|vaquill/.test(value)) return "legal";
  if (/actaport|system.?one|clio|lawve|counsel|practice|ra-micro|advoware/.test(value)) return "practice";
  return "productivity";
}

export function popularConnector(id: string) {
  return ["gmail", "outlook", "google-drive", "google-calendar", "onedrive", "sharepoint-files"].includes(id);
}
