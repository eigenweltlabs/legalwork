#!/usr/bin/env node
// Read-only lookup. No dependencies, network requests or workspace writes.
import { readFileSync } from "node:fs";

const [locale, ...terms] = process.argv.slice(2);
const query = terms.join(" ").trim();
const reference = JSON.parse(readFileSync(new URL("../references/i18n.json", import.meta.url), "utf8"));
if (!locale || !query || !Object.hasOwn(reference.locales, locale)) {
  console.error(`Usage: node lookup-label.mjs <locale> <key or label text>\nLocales: ${Object.keys(reference.locales).join(", ")}. Shipped: ${reference.shippedLocales.join(", ")}.`);
  process.exitCode = 1;
} else {
  const selected = reference.locales[locale];
  const english = reference.locales[reference.sourceLocale].entries;
  const keys = [...new Set(Object.values(reference.locales).flatMap((item) => Object.keys(item.entries)))].sort();
  const needle = query.toLocaleLowerCase();
  const found = keys.includes(query) ? [query] : keys.filter((key) =>
    key.toLocaleLowerCase().includes(needle) || Object.values(reference.locales).some((item) =>
      item.entries[key]?.toLocaleLowerCase().includes(needle),
    ),
  );
  console.log(JSON.stringify({
    locale,
    shipped: selected.shipped,
    ...(!selected.shipped ? { notice: "This locale is incomplete and is not selectable in the app. Values below are archival translations." } : {}),
    query,
    totalMatches: found.length,
    truncated: found.length > 30,
    matches: found.slice(0, 30).map((key) => ({
      key,
      label: selected.entries[key] ?? null,
      english: english[key] ?? null,
      translations: Object.fromEntries(Object.entries(reference.locales)
        .filter(([, item]) => Object.hasOwn(item.entries, key))
        .map(([code, item]) => [code, item.entries[key]])),
    })),
  }, null, 2));
}
