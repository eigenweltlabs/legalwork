/**
 * German translations (Deutsch)
 * Professional terms (Skills, Plugins, Commands, Sessions, OpenCode, OpenPackage, LegalWork) are NOT translated.
 *
 * This locale spreads the English base so every key is present, then overrides
 * the most visible surfaces (settings, secrets, language, core navigation) with
 * German. Any key not listed here falls back to its English value.
 */
import en from "./en";

const de: Record<string, string> = {
  ...en,

  /* ---- Common actions ---- */
  "common.add": "Hinzufügen",
  "common.back": "Zurück",
  "common.cancel": "Abbrechen",
  "common.close": "Schließen",
  "common.edit": "Bearbeiten",
  "common.remove": "Entfernen",
  "common.save": "Speichern",

  /* ---- Navigation / chrome ---- */
  "dashboard.back_to_app": "Zurück zur App",
  "session.new_task": "Neue Aufgabe",
  "session.preparing_workspace": "Arbeitsbereich wird vorbereitet",
  "status.back": "Zurück zum vorherigen Bildschirm",
  "status.connected": "Verbunden",
  "status.ready_for_tasks": "Bereit für neue Aufgaben",
  "status.settings": "Einstellungen",

  /* ---- Settings: groups & tabs ---- */
  "settings.group_cloud": "Cloud",
  "settings.group_global": "Allgemein",
  "settings.group_workspace": "Arbeitsbereich",
  "settings.tab_general": "Einstellungen",
  "settings.tab_description_general":
    "Anbieter verbinden, Ordner freigeben und den ausgewählten LegalWork-Arbeitsbereich samt Laufzeitverbindung steuern.",
  "settings.tab_extensions": "Erweiterungen",
  "settings.tab_description_skills": "Skills durchsuchen, bearbeiten und installieren – direkt in den Einstellungen.",
  "settings.tab_updates": "Updates",
  "settings.tab_description_updates":
    "Halte die App mit unauffälligen Hintergrundprüfungen und Installationssteuerung aktuell.",
  "settings.tab_recovery": "Wiederherstellung",
  "settings.tab_description_recovery":
    "Häufige Probleme beheben, Arbeitsbereichseinstellungen zurücksetzen oder Restdaten bereinigen.",
  "settings.tab_appearance": "Sprache",
  "settings.tab_description_appearance": "Wähle die Anzeigesprache der App.",

  /* ---- Settings: language ---- */
  "settings.language": "Sprache",
  "settings.language.description": "Wähle deine bevorzugte Sprache",

  /* ---- Settings: Secrets (environment) ---- */
  "settings.tab_environment": "Geheimnisse",
  "settings.tab_description_environment":
    "Speichere API-Schlüssel und Passwörter für die Dienste, mit denen sich dein Assistent verbindet.",
  "settings.environment.title": "Geheimnisse",
  "settings.environment.description":
    "Speichere die API-Schlüssel und Passwörter, die dein Assistent braucht, um sich mit anderen Diensten zu verbinden. Sie werden sicher auf diesem Gerät gespeichert und verlassen es nie.",
  "settings.environment.add_button": "Geheimnis hinzufügen",
  "settings.environment.add_title": "Geheimnis hinzufügen",
  "settings.environment.edit_title": "Geheimnis bearbeiten",
  "settings.environment.delete_title": "Geheimnis löschen",
  "settings.environment.empty_title": "Noch keine Geheimnisse",
  "settings.environment.empty_body":
    "Füge ein Geheimnis hinzu – etwa einen API-Schlüssel oder ein Passwort –, damit sich dein Assistent mit Diensten wie Google, OpenAI oder GitHub verbinden kann.",
  "settings.environment.empty_value": "(leer)",
  "settings.environment.key_label": "Name",
  "settings.environment.key_hint":
    "Ein kurzer Name, um dieses Geheimnis später wiederzuerkennen. Verwende Buchstaben, Zahlen und Unterstriche.",
  "settings.environment.value_label": "Geheimnis",
  "settings.environment.cancel": "Abbrechen",
  "settings.environment.save": "Speichern",
  "settings.environment.saving": "Wird gespeichert…",
  "settings.environment.delete": "Löschen",
  "settings.environment.deleting": "Wird gelöscht…",
  "settings.environment.reveal": "Anzeigen",
  "settings.environment.hide": "Verbergen",
  "settings.environment.loading": "Wird geladen…",
  "settings.environment.click_to_edit": "Zum Bearbeiten klicken",
  "settings.environment.table_actions": "Aktionen",
  "settings.environment.updated_at": "Aktualisiert {date}",
  "settings.environment.confirm_delete":
    "{key} löschen? Dein Assistent verwendet es nicht mehr, sobald du die Änderungen anwendest.",
  "settings.environment.apply_button": "Änderungen anwenden",
  "settings.environment.applying": "Wird angewendet…",
  "settings.environment.apply_pending_title": "Gespeichert – noch nicht aktiv",
  "settings.environment.apply_pending_body": "Wende deine Änderungen an, damit dein Assistent sie verwenden kann.",
  "settings.environment.apply_title": "Geheimnis-Änderungen anwenden?",
  "settings.environment.apply_confirm_body":
    "LegalWork aktualisiert deinen Assistenten, damit er die neuesten Geheimnisse verwenden kann. Laufende Aufgaben werden möglicherweise gestoppt.",
  "word_addin.connecting": "Verbinde mit LegalWork...",
  "word_addin.connect_error_title": "LegalWork ist nicht erreichbar",
  "word_addin.connect_error_body": "Stelle sicher, dass der LegalWork-Server mit aktiviertem Word-Add-in läuft, und versuche es erneut.",
  "word_addin.connect_retry": "Erneut versuchen",
  "word_addin.add_selection": "Auswahl in den Chat übernehmen",
  "word_addin.add_document": "Dokument in den Chat übernehmen",
  "word_addin.insert_reply": "Letzte Antwort am Cursor einfügen",
  "word_addin.empty_selection": "Bitte zuerst Text im Dokument auswählen.",
  "word_addin.empty_document": "Das Dokument enthält noch keinen Text.",
  "word_addin.no_reply": "Noch keine Antwort zum Einfügen vorhanden.",
  "word_addin.inserted": "In das Dokument eingefügt.",
  "word_addin.selection_context_label": "Ausgewählter Text aus dem Word-Dokument:",
  "word_addin.document_context_label": "Text des Word-Dokuments:",
  "word_addin.context_truncated": "(Das Dokument wurde gekürzt, da es sehr lang ist.)",
};

export default de;
