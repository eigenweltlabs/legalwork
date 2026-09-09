/**
 * i18n coverage + house-style check.
 *
 * Answers "is everything translated?" mechanically instead of by eye:
 *   - every key in en.ts exists in every locale,
 *   - no locale silently ships the English string (allowlist for real
 *     loanwords and product names),
 *   - placeholders (`{name}`) survive translation,
 *   - plural families are complete for the locale's CLDR categories,
 *   - German follows the house style: formal "Sie", no em/en dashes.
 *
 * Run with `pnpm --filter @legalwork/app test:i18n`.
 */
import en from "../src/i18n/locales/en";
import de from "../src/i18n/locales/de";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LANGUAGES, LANGUAGE_OPTIONS, matchLanguageTag, type Language } from "../src/i18n";

type Dict = Record<string, string>;

const LOCALES: Record<Language, Dict> = {
  en: en as Dict,
  de: de as Dict,
};

const SOURCE = LOCALES.en;
const failures: string[] = [];
const fail = (message: string) => failures.push(message);

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/**
 * Strings a German reader sees unchanged: brand and product names, loanwords
 * German uses as-is, and single tokens that are identical in both languages.
 * Everything else matching English is an untranslated string.
 */
const GERMAN_KEEPS_ENGLISH = new Set<string>([
  // Tool transcript: loanwords and identical tokens
  "terminal.region_label", "message_list.skill_badge", "benchmark.run_name_placeholder",
  "provider_auth.name", "hub_share.skills", "hub_share.plugins",
  "learnings.details", "learnings.ma", "learnings.title",
  "tool.generic", "tool.detail_in_path", "tool_activity.agent_prefix",
  "reload.label_skill", "reload.label_plugin", "reload.label_mcp", "reload.label_agent",
  // Product and brand names
  "benchmark.onboarding_eyebrow", "benchmark.import_title", "settings.tab_benchmark",
  "account.plan_hub", "premium_upsell.eyebrow", "onboarding_ai.panel_eyebrow",
  "recorder.tier_premium_name", "recorder.tier_premium_locked", "recorder.tier_max_name",
  "skills.cloud_org_fallback", "mcp.quick_connect_featured",
  // Professional terms LegalWork deliberately leaves untranslated
  "composer.agent_label", "composer.agents_label", "composer.mcps_label", "composer.skill_source",
  "composer.app_kind", "session.permission_detail_agent", "session.permission_detail_tool",
  "session.permission_detail_diff", "session.permission_detail_url", "session.doom_loop_tool_label",
  "session.doom_loop_label", "dashboard.commands", "dashboard.skills", "dashboard.desktop_badge",
  "dashboard.remote", "workspace.remote_badge", "workspace.sandbox_badge",
  "share_skill_destination.remote_badge", "share_skill_destination.sandbox_badge",
  "settings.tab_skills", "settings.tab_updates", "settings.updates", "settings.tab_debug",
  "settings.group_cloud", "settings.engine_title", "settings.opencode_section_label",
  "settings.theme_system", "settings.model_title", "settings.model", "settings.export",
  "settings.reset_button", "settings.reset", "settings.startup", "settings.startup_title",
  "settings.provider_source_custom", "settings.cap_commands", "settings.cap_mcp",
  "settings.cap_skills", "settings.cap_sandbox", "settings.debug_commit", "settings.debug_pid",
  "settings.debug_port", "settings.debug_opencode_version", "settings.error",
  "settings.no_custom_path_set", "settings.worker_id_label", "settings.worker_unresolved",
  "settings.status_label", "settings.default_label", "settings.diag_default",
  "mcp.apps_title", "mcp.your_apps", "mcp.available_apps", "mcp.server_type", "mcp.logout_label",
  "mcp.oauth_scope", "mcp.oauth_client_id", "mcp.oauth_client_secret", "mcp.server_url",
  "mcp.server_command_placeholder", "mcp.server_name_placeholder", "mcp.server_url_placeholder",
  "mcp.type_remote", "mcp.friendly_status_offline", "mcp.config_file", "mcp.scope_global",
  "mcp.scope_project", "mcp.technical_details", "mcp.last_synced", "mcp.oauth_advanced_title",
  "mcp.auth.callback_placeholder", "mcp.auth.reauth_cli_hint", "mcp.auth.port_forward_hint",
  "mcp.auth.oauth_failed", "mcp.auth.copy_link", "mcp.auth.authorization_link",
  "identities.app_token_label", "identities.status_label", "identities.channel_label",
  "identities.tab_general", "identities.peer_id_label", "identities.peer_id_placeholder_telegram",
  "identities.worker_offline", "identities.worker_online", "identities.health_offline",
  "identities.bot_token_label", "identities.bot_token_placeholder", "identities.days_ago",
  "config.host_offline", "config.worker_id", "config.workspace_id_prefix",
  "config.server_url_label", "config.server_url_input_label", "config.collaborator_token_label",
  "config.owner_token_label", "config.host_admin_token_label", "config.server_section_title",
  "session.model", "session.workspace_fallback", "session.share_worker_url",
  "session.share_opencode_base_url", "session.share_collaborator_label", "session.details",
  "session.details_label", "session.permission_detail_files", "session.permission_kind_skill",
  "session.cmd_switch", "share.workspace_fallback", "workspace_list.workspace_fallback",
  "workspace_list.test_connection", "skills.title", "skills.filter_hub", "skills.hub_label",
  "skills.filter_cloud", "skills.cloud_footer_label", "skills.ref_label",
  "skills.no_opencode_workspace", "skills.no_skills", "skills.failed_load_opencode",
  "skills.failed_parse_opencode", "skills.failed_update_opencode", "skills.no_opencode_found",
  "plugins.title", "plugins.scope_global", "plugins.add_hint", "plugins.desc",
  "extensions.apps_mcp_header", "extensions.plugins_opencode_header", "extensions.filter_apps",
  "extensions.filter_plugins", "fusion.panel_title", "fusion.toggle_label",
  "fusion.settings_model_slot", "status.docs", "status.feedback", "status.mcp_connected",
  "status.limited_mcp_hint", "status.legalwork_ready", "system.reload_body_default",
  "firm_hub.scope_team", "firm_hub.presets", "word_addin.workspaces_title",
  "word_addin.sessions_title", "onboarding_office.panel_footer", "recorder.overlay_title",
  "recorder.dictation_test_label", "benchmark.filter_tags", "benchmark.form_tags",
  "model_behavior.label_standard", "settings.provider_source_config",
  "benchmark.filter_status", "settings.cap_plugins", "settings.debug_hostname",
  "settings.diag_workspaces", "settings.language_system",
  // Third-party product names in the quick-connect catalog.
  "mcp.quick_connect_box_title", "mcp.quick_connect_courtlistener_title",
  "mcp.quick_connect_dingduff_title", "mcp.quick_connect_dropbox_title",
  "mcp.quick_connect_egnyte_title", "mcp.quick_connect_everlaw_title",
  "mcp.quick_connect_google_cloud_storage_title", "mcp.quick_connect_highq_title",
  "mcp.quick_connect_imanage_title", "mcp.quick_connect_ironclad_title",
  "mcp.quick_connect_legalmemory_title", "mcp.quick_connect_netdocuments_title",
  "mcp.quick_connect_notion_title", "mcp.quick_connect_legalwork_admin_title",
  "mcp.quick_connect_legalwork_cloud_title", "mcp.quick_connect_legalwork_ui_title",
  "mcp.quick_connect_relativity_title", "mcp.quick_connect_ruly_title",
  "mcp.quick_connect_sharepoint_title", "mcp.quick_connect_taxgraph_title",
  // Identical in German: "Branding", "Name", "Updates", "Pause".
  "settings.customization.branding_title", "settings.environment.key_label",
  "settings.updates_title", "word_addin.workspace_name", "recorder.pause",
  "providers.local_model_label", "extension_detail.client_examples",
  "session.viewer", "google_workspace.feature_chat", "mcp.scope_optional",
  "benchmark.legal_agent_benchmark", "settings.group_workspace",
  "sidebar.memory_drive", "sidebar.workflows",
  "skills.eyebrow_skill", "skills.workflows_title", "mcp.filter_mcps", "mcp.filter_skills",
  "extension_card.kind_mcp", "extension_card.kind_plugin", "extension_card.kind_skill",
  "side_panel.browser",
]);

/** Text that speaks TO the agent, where "du" is the intended register. */
const AGENT_FACING = new Set<string>([
  "blueprint.starter_blueprint_prompt", "blueprint.starter_chrome_prompt",
  "blueprint.starter_command_prompt", "blueprint.starter_csv_prompt",
  "blueprint.starter_explore_prompt", "blueprint.csv_session_user",
  "blueprint.csv_session_assistant", "recorder.copilot_suggest_prompt",
  "recorder.live_share_notice",
  // Tool results handed back to the agent, not rendered for the reader.
  "docx.draft_changed_while_reading", "docx.read_draft_again", "docx.target_ambiguous",
  "markdown.unknown_tool", "markdown.search_replace_required", "markdown.edit_remains",
  "pptx.slide_not_found", "pptx.element_not_editable", "pptx.search_must_match_once",
  "xlsx.sheet_not_found",
  // Starter prompts the user sends to the agent.
  "task_suggestions.grid_prompt", "task_suggestions.redline_prompt",
  "task_suggestions.summary_prompt",
  // Sample chat content and quoted example prompts.
  "onboarding_ai.chat_user", "mcp.quick_connect_legalwork_ui_desc",
  "mcp.quick_connect_legalwork_cloud_desc", "mcp.quick_connect_legalwork_admin_desc",
]);

/* ---------------------------------------------------------------- */
/*  Registry sanity                                                  */
/* ---------------------------------------------------------------- */

for (const language of LANGUAGES) {
  if (!LOCALES[language]) fail(`no dictionary registered for "${language}"`);
  if (!LANGUAGE_OPTIONS.some((option) => option.value === language)) {
    fail(`"${language}" is missing from LANGUAGE_OPTIONS`);
  }
}

/* ---------------------------------------------------------------- */
/*  Auto-detection                                                   */
/* ---------------------------------------------------------------- */

const DETECTION_CASES: Array<[string, Language | null]> = [
  ["de", "de"],
  ["de-DE", "de"],
  ["de-AT", "de"],
  ["DE-ch", "de"],
  ["en", "en"],
  ["en-GB", "en"],
  ["en-US", "en"],
  ["", null],
  // Languages we do not ship must not resolve: detection and the Settings
  // picker both read LANGUAGES, so an unshipped locale can never be selected.
  ["fr-FR", null],
  ["pt-BR", null],
  ["zh-Hans", null],
  ["ja", null],
  ["ru", null],
];
for (const [tag, expected] of DETECTION_CASES) {
  const actual = matchLanguageTag(tag);
  if (actual !== expected) fail(`matchLanguageTag(${JSON.stringify(tag)}) = ${actual}, expected ${expected}`);
}

/* ---------------------------------------------------------------- */
/*  Coverage                                                         */
/* ---------------------------------------------------------------- */

/**
 * Every shipped language is held to full coverage: a language only enters
 * `LANGUAGES` once it is finished, so a partial one can never reach the
 * Settings picker or auto-detection.
 */
for (const language of LANGUAGES) {
  if (language === "en") continue;
  const dict = LOCALES[language];

  const missing = Object.keys(SOURCE).filter((key) => !(key in dict));
  if (missing.length) {
    fail(`${language}: ${missing.length} key(s) missing, first: ${missing.slice(0, 5).join(", ")}`);
  }

  const extra = Object.keys(dict).filter((key) => !(key in SOURCE));
  if (extra.length) {
    fail(`${language}: ${extra.length} key(s) not in en.ts, first: ${extra.slice(0, 5).join(", ")}`);
  }

  // A placeholder dropped in translation breaks the string at runtime in ANY
  // locale, so this one is a hard failure everywhere.
  for (const [key, source] of Object.entries(SOURCE)) {
    const value = dict[key];
    if (typeof value !== "string") continue;
    if (!value.trim()) fail(`${language}: "${key}" is empty`);
    const a = placeholders(source);
    const b = placeholders(value);
    if (a.join("|") !== b.join("|")) {
      fail(`${language}: "${key}" placeholders ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
  }

  // A `_one` variant needs either its `_other` sibling or the bare key, which
  // is what `resolvePluralKey` falls back to.
  const families = new Set<string>();
  for (const key of Object.keys(SOURCE)) {
    const base = key.replace(/_(zero|one|two|few|many|other)$/, "");
    if (base !== key) families.add(base);
  }
  for (const base of families) {
    if (!(`${base}_other` in dict) && !(base in dict)) {
      fail(`${language}: plural family "${base}" resolves to nothing (no "${base}_other", no "${base}")`);
    }
  }
}

/* ---------------------------------------------------------------- */
/*  German completeness + house style                                */
/* ---------------------------------------------------------------- */

const german = LOCALES.de;

const untranslated = Object.keys(SOURCE).filter(
  (key) => german[key] === SOURCE[key] && !GERMAN_KEEPS_ENGLISH.has(key),
);
if (untranslated.length) {
  fail(
    `de: ${untranslated.length} string(s) still English. Translate them, or add genuine loanwords to GERMAN_KEEPS_ENGLISH:\n    ` +
      untranslated.slice(0, 25).join("\n    "),
  );
}

const emDashes = Object.keys(german).filter((key) => german[key].includes("—"));
if (emDashes.length) fail(`de: em dash in ${emDashes.length} string(s): ${emDashes.slice(0, 10).join(", ")}`);

const enDashes = Object.keys(german).filter((key) => /\s–\s/.test(german[key]));
if (enDashes.length) fail(`de: en dash used as punctuation in: ${enDashes.slice(0, 10).join(", ")}`);

const informal = Object.keys(german).filter(
  (key) =>
    !AGENT_FACING.has(key) &&
    /\b(du|dich|dir|dein|deine|deinem|deinen|deiner|deines)\b/i.test(german[key]),
);
if (informal.length) {
  fail(`de: informal address ("du") in: ${informal.slice(0, 10).join(", ")}`);
}

/**
 * Informal imperatives ("Wähle …") read as "du" even without the pronoun. The
 * formal form is the infinitive plus "Sie" ("Wählen Sie …"), so the bare stem
 * only appears in text that addresses the reader informally.
 */
const INFORMAL_IMPERATIVE =
  /(^|[.!?“„"(\s])(Wähle|Öffne|Klicke|Gib|Nutze|Starte|Füge|Lade|Prüfe|Verbinde|Kopiere|Speichere|Erstelle|Schließe|Beende|Drücke|Ändere|Setze|Trage|Lege|Richte|Warte|Versuche|Schau|Sieh|Beachte|Melde|Abonniere|Entferne|Installiere|Aktiviere|Deaktiviere|Wechsle|Behalte|Halte)(\s|$)/;
const informalImperatives = Object.keys(german).filter(
  (key) => !AGENT_FACING.has(key) && INFORMAL_IMPERATIVE.test(german[key]),
);
if (informalImperatives.length) {
  fail(
    `de: informal imperative (use "Wählen Sie …", not "Wähle …") in: ${informalImperatives.slice(0, 10).join(", ")}`,
  );
}

/* ---------------------------------------------------------------- */
/*  No `t()` frozen at import time                                    */
/* ---------------------------------------------------------------- */

/**
 * `t()` reads the current language when it runs. A top-level `const` that
 * calls it evaluates once at import, so those strings stay in whatever
 * language loaded first and never follow a switch. Wrap them in a function
 * (or a `get` accessor) so each read re-resolves.
 */
const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const sourceFiles: string[] = [];
const collect = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", "dist", "assets"].includes(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collect(path);
    else if (/\.(tsx|ts)$/.test(path)) sourceFiles.push(path);
  }
};
collect(SOURCE_ROOT);

const CALLS_T = /(^|[^.\w])t\(\s*"/;
const LAZY = /=>|\bfunction\b|\bget\s+\w+\s*\(/;

for (const file of sourceFiles) {
  const lines = readFileSync(file, "utf8").split("\n");
  let depth = 0;
  let start = -1;
  let name = "";
  let callsT = false;
  let lazy = false;

  lines.forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "");
    if (depth === 0) {
      const declaration = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(.*)$/.exec(code);
      if (declaration) {
        start = index + 1;
        name = declaration[1];
        callsT = CALLS_T.test(declaration[2]);
        lazy = LAZY.test(declaration[2]);
      }
    }
    if (start > 0) {
      if (CALLS_T.test(code)) callsT = true;
      if (LAZY.test(code)) lazy = true;
    }
    for (const character of code) {
      if ("([{".includes(character)) depth++;
      else if (")]}".includes(character)) depth--;
    }
    if (start > 0 && depth <= 0) {
      if (callsT && !lazy) {
        fail(
          `${relative(SOURCE_ROOT, file)}:${start}: const ${name} calls t() at import time, so it never follows a language switch. Make it a function or use \`get\` accessors.`,
        );
      }
      start = -1;
      callsT = false;
      lazy = false;
      depth = Math.max(depth, 0);
    }
  });
}

/* ---------------------------------------------------------------- */

if (failures.length) {
  console.error(`i18n check FAILED (${failures.length} problem(s)):\n`);
  for (const failure of failures) console.error(`  • ${failure}\n`);
  process.exit(1);
}

const total = Object.keys(SOURCE).length;
console.log(
  `i18n check passed: ${total} keys × ${LANGUAGES.length} shipped languages (${LANGUAGES.join(", ")}), all complete.`,
);
