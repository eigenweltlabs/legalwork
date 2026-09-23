/** Simple Icons marks bundled in `public/` as `ext-<slug>.svg` (CC0-1.0). */
const BUNDLED_BRAND_ICONS = new Set(["box", "dropbox", "egnyte", "google", "googlecloud", "notion"]);

export function resolveExtensionIconSrc(iconSrc: string): string {
  if (!iconSrc.startsWith("/")) {
    return iconSrc;
  }

  const base = import.meta.env.BASE_URL || "/";
  return `${base.replace(/\/?$/, "/")}${iconSrc.replace(/^\/+/, "")}`;
}

/**
 * Resolve an extension's brand mark: an explicit `iconSrc` first, then a
 * bundled Simple Icons slug. Both stay inside the app bundle — a slug we do
 * not ship resolves to nothing and falls back to a generated avatar, so
 * rendering an extension never tells a CDN which connectors a firm uses.
 */
export function resolveBrandIconSrc(iconSrc?: string, iconSlug?: string): string | undefined {
  if (iconSrc) return resolveExtensionIconSrc(iconSrc);
  if (iconSlug && BUNDLED_BRAND_ICONS.has(iconSlug)) return resolveExtensionIconSrc(`/ext-${iconSlug}.svg`);
  return undefined;
}
