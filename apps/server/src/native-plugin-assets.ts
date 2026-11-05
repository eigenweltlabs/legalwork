/** A compiled server installs the same standalone bundles that desktop ships
 * as resources. The engine supplies @opencode/plugin/effect in both cases. */
let bundles: Readonly<Record<string, string>> = {};
export function installEmbeddedNativePluginBundles(value: Readonly<Record<string, string>>) { bundles = value; }
export function embeddedNativePluginBundle(name: string): string | undefined { return bundles[name]; }
