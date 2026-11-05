# Localization and exact UI labels

Open in LegalWork: [Customization](legalwork://app/settings/shell).

## Change the app language

Open **Settings > Customization** and find the display-language selector. Choose **English**, **Deutsch**, or **System**. System follows the OS/browser language; a supported German regional preference such as `de-AT` or `de-CH` resolves to German, otherwise the first supported preferred language is used, with English as the fallback. An explicit choice persists until you change it. The app repaints when the language changes, without requiring an engine reload.

Only English (`en`) and German (`de`) are registered for this build. The separate Language/Appearance settings route is retained in code but hidden from ordinary navigation. Use Customization for the reachable selector.

## Full translation reference

[i18n.json](i18n.json) is generated from **every** locale table under `apps/app/src/i18n/locales/`. It also expands the shared project-template translations used by the UI. It includes all existing button translations plus menu labels, headings, accessibility labels, tooltips, descriptions, status/error messages, placeholders and plural forms. Nothing is filtered to a guessed list of button keys.

The schema contains `shippedLocales` and `locales[code]`, with `shipped`, `source`, `sha256`, `entryCount` and `entries`. An entry maps the original translation key to its exact source value. English is the source locale. The nine other existing tables (`ca`, `es`, `fr`, `ja`, `pt-BR`, `ru`, `th`, `vi`, `zh`) are included completely as they exist, but are incomplete and **not shipped UI languages**. Missing translations are not invented or filled into those tables.

Use the `legalwork-help` lookup script to search without loading the complete JSON into the conversation:

```sh
node .opencode/skills/legalwork-help/scripts/lookup-label.mjs de settings.tab_ai
node .opencode/skills/legalwork-help/scripts/lookup-label.mjs de "Save"
node .opencode/skills/legalwork-help/scripts/lookup-label.mjs en "Speichern"
```

The first argument is the locale to display; the remaining argument is an exact key or text to search across keys and all existing translations. Exact keys return one record. Text searches return up to 30 records with the total match count and a truncation flag; narrow the query if truncated. Each match includes the requested label, English label and all existing translations. `null` means that table has no entry. An unshipped-locale warning means those values are archival, not current selectable buttons. The helper reads only the bundled file and can run without a network connection.

## Give accurate localized instructions

Check the visible app language instead of inferring it from the question. The user may ask in English while using German menus. Match the full translation key and surrounding UI context: "Save" in a document panel can be different from saving a provider configuration. Keep `{name}`, `{count}` and other placeholders intact until their real values are known. Plural keys such as `_one` and `_other` are intentional. Runtime lookup falls back from the selected language to English and then to the key; the reference preserves missing entries so gaps remain visible.

The reference also contains legacy/hidden strings because the task is to preserve every existing translation. A matching label is not proof that a button exists in the current screen. Cross-check [Feature availability](feature-availability.md) and the relevant topic. Proper names and labels supplied dynamically by a provider, plugin, operating system or user are not translations in these app tables.
