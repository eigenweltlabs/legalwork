# Translations

Every user-facing string lives in a locale file; nothing renders literal
English from a component. **English and German ship, and both are complete** —
a language only enters `LANGUAGES` once it is finished, so a half-translated
one can never reach the Settings picker or auto-detection.

`locales/` also holds partial `ja`, `zh`, `vi`, `pt-BR`, `th`, `fr`, `ca`,
`es` and `ru` files from an earlier pass (all under 50% translated). They are
parked, not shipped: nothing imports them, so they are absent from the picker
and from detection. Finish one and register it (below) to bring it back, or
delete the file if it is not wanted.

## How it fits together

| File | Role |
|---|---|
| `index.ts` | `Language`, `LANGUAGE_OPTIONS`, the `t()` lookup, and the language state (detection, persistence, subscriptions) |
| `locales/en.ts` | The **source of truth**. Every other locale mirrors its keys |
| `locales/de.ts` | German, complete, in the same key order as `en.ts` |
| `locales/index.ts` | Re-exports the **shipped** locales only |
| `use-locale.ts` | `useLocale()` / `useLanguagePreference()`, the subscription that repaints the app on a language switch |
| `../../scripts/i18n-check.ts` | The coverage and house-style gate (`pnpm test:i18n`) |

## Language resolution

1. `localStorage["legalwork.language"]`, written only when someone picks a
   language in Settings,
2. otherwise the OS/browser language via `navigator.languages` (this is the
   auto-detection: `de-AT` and `de-CH` both resolve to `de`),
3. otherwise English.

Picking **System** in Settings → Customization stores `"system"`, so the app
follows the OS again. `setLanguagePreference` notifies subscribers, and
`AppRoot` subscribes through `useLocale()`, so a switch repaints immediately
with no reload.

## Adding a language

1. Copy `locales/en.ts` to `locales/<code>.ts` and translate **every** value —
   the check fails on any key left in English.
2. Add its code to `Language`, `LANGUAGES`, `LANGUAGE_OPTIONS` (native name),
   `TRANSLATIONS` and `pluralRulesByLanguage` in `index.ts`.
3. Re-export it from `locales/index.ts`.
4. Register it in `LOCALES` in `scripts/i18n-check.ts` and add a detection case.

A regional code (`pt-BR`) also needs an alias in `matchLanguageTag` so a bare
`pt` resolves to it. Otherwise detection, the Settings picker and the plural
handling pick the new language up with no further changes.

## Rules the check enforces

`pnpm --filter @legalwork/app test:i18n` fails on:

- a German key that is missing, empty, or still the English string (real
  loanwords and product names are allowlisted in the script),
- a placeholder (`{name}`) dropped in **any** locale,
- a plural family that resolves to nothing,
- German house style: formal address ("Wählen Sie", never "Wähle" or "du"),
  no em dashes and no en dashes as sentence punctuation,
- `t()` called at module scope, which would freeze that string in whatever
  language loaded first. Wrap those in a function or a `get` accessor.
