export type HiddenLauncherItem = { id: string; title: string };
const key = (server: string) => `legalwork.launcher.hidden.v1:${server}`;
export function readHiddenItems(server: string): HiddenLauncherItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(server)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item: unknown) => item && typeof item === "object" && "id" in item && "title" in item && typeof item.id === "string" && typeof item.title === "string" && item.id !== "home:history" && !item.id.startsWith("home:search:") ? [{ id: item.id, title: item.title }] : []);
  } catch { return []; }
}
export function writeHiddenItems(server: string, items: HiddenLauncherItem[]) {
  localStorage.setItem(key(server), JSON.stringify(items));
  window.dispatchEvent(new Event("legalwork:launcher-hidden"));
}
