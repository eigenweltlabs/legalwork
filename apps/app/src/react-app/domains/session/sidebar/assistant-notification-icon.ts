import type { AssistantIcon } from "@legalwork/types/main-assistant";
import { assistantAvatarIcon, assistantAvatarImages } from "./assistant-avatar-assets";

const icons = new Map<AssistantIcon, Promise<string | undefined>>();

/** Small PNGs cross the desktop bridge, never renderer URLs or local file paths. */
export function assistantNotificationIcon(icon: AssistantIcon): Promise<string | undefined> {
  const cached = icons.get(icon);
  if (cached) return cached;
  const pending = renderIcon(icon).catch(() => { icons.delete(icon); return undefined; });
  icons.set(icon, pending);
  return pending;
}

async function renderIcon(icon: AssistantIcon): Promise<string | undefined> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  const image = new Image();
  image.src = assistantAvatarImages[assistantAvatarIcon(icon)];
  await image.decode();
  const scale = 128 / Math.max(image.naturalWidth, image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  context.drawImage(image, (128 - width) / 2, (128 - height) / 2, width, height);
  return canvas.toDataURL("image/png");
}
