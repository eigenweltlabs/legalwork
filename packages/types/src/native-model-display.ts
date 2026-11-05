/** Display metadata is never submitted as an executable model setting. */
export type NativeModelDisplay = { legalwork?: { defaultVariantID: string | null } };
export type NativeProviderDisplay = { legalwork?: { hasCustomEndpoint: boolean } };

type Overlays = {
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
};
type Model = Overlays & { variants: ReadonlyArray<Overlays & { id: string }> };

function overlayAlreadyApplied(current: unknown, overlay: unknown): boolean {
  if (Object.is(current, overlay)) return true;
  if (Array.isArray(overlay)) return Array.isArray(current) && current.length === overlay.length && overlay.every((item, index) => overlayAlreadyApplied(current[index], item));
  if (overlay && typeof overlay === "object" && Object.keys(overlay).length === 0) return true;
  if (!overlay || typeof overlay !== "object" || !current || typeof current !== "object" || Array.isArray(current)) return false;
  return Object.entries(overlay).every(([key, value]) => overlayAlreadyApplied(Reflect.get(current, key), value));
}

/** Infer before private transport overlays are removed from client catalogs. */
export function inferNativeDefaultVariant(model: Model) {
  const headers = (input: Record<string, string> | undefined) => Object.fromEntries(Object.entries(input ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  return model.variants.find(variant => {
    const overlays = [[model.settings, variant.settings], [model.body, variant.body], [headers(model.headers), headers(variant.headers)]];
    return overlays.some(([, value]) => value && Object.keys(value).length > 0)
      && overlays.every(([current, value]) => !value || overlayAlreadyApplied(current, value));
  })?.id;
}

/** Raw standalone clients retain inference; public projections supply an
 * authoritative null as well, so removed secret fields cannot invent a match. */
export function nativeDefaultVariant(model: Model & NativeModelDisplay) {
  if (model.legalwork) return model.variants.some(variant => variant.id === model.legalwork?.defaultVariantID) ? model.legalwork.defaultVariantID ?? undefined : undefined;
  return inferNativeDefaultVariant(model);
}
