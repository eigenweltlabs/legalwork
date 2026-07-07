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
  "office_addins.tab_label": "Office-Add-ins",
  "office_addins.tab_description": "LegalWork in Word, Excel und PowerPoint",
  "office_addins.about_title": "LegalWork in Microsoft Office",
  "office_addins.about_body":
    "Installiere das LegalWork-Add-in, um den Agenten in einer Seitenleiste in Word, Excel und PowerPoint zu öffnen. Es läuft lokal gegen diese App – es verlassen keine Daten deinen Rechner.",
  "office_addins.requires_desktop_title": "Desktop-App erforderlich",
  "office_addins.requires_desktop": "Office-Add-ins können nur aus der LegalWork-Desktop-App installiert werden.",
  "office_addins.unsupported_title": "Auf dieser Plattform noch nicht unterstützt",
  "office_addins.unsupported_body": "Die Installation des Office-Add-ins wird derzeit unter macOS unterstützt. Windows folgt.",
  "office_addins.status_title": "LegalWork-Add-in",
  "office_addins.status_enabled": "Installiert und aktiv.",
  "office_addins.status_disabled": "Nicht installiert.",
  "office_addins.install": "Installieren",
  "office_addins.installing": "Wird installiert…",
  "office_addins.uninstall": "Deinstallieren",
  "office_addins.open_app": "{app} öffnen",
  "office_addins.open_app_failed": "{app} konnte nicht geöffnet werden.",
  "office_addins.uninstalling": "Wird entfernt…",
  "office_addins.loading": "Status wird geprüft…",
  "office_addins.cert_trusted": "Lokales Zertifikat vertraut",
  "office_addins.listener_running": "Add-in-Server läuft auf Port {port}",
  "office_addins.app_ready": "{app}: bereit",
  "office_addins.app_not_installed": "{app}: Add-in nicht installiert",
  "office_addins.no_office_apps_title": "Keine Office-Apps gefunden",
  "office_addins.no_office_apps": "Es wurden keine Microsoft-Office-Apps auf diesem Rechner gefunden.",
  "office_addins.app_status_installed": "Das LegalWork-Add-in ist in {app} installiert.",
  "office_addins.app_status_not_installed": "Füge die LegalWork-Seitenleiste zu {app} hinzu.",
  "office_addins.shared_title": "Gemeinsame Komponenten",
  "office_addins.shared_desc": "Ein lokales Zertifikat und ein Add-in-Server bedienen alle installierten Office-Apps.",
  "office_addins.cancel": "Abbrechen",
  "office_addins.cert_prompt_title": "Sichere lokale Verbindung einrichten",
  "office_addins.cert_prompt_body":
    "LegalWork erstellt ein privates Zertifikat, damit Office auf deinem Mac über eine sichere Verbindung mit dieser App kommunizieren kann. macOS fragt einmalig nach deinem Passwort, um dieses Zertifikat als vertrauenswürdig einzustufen.",
  "office_addins.restart_title": "Installation erfolgreich",
  "office_addins.restart_body":
    "Beende {app} vollständig (Cmd+Q) und öffne es erneut. LegalWork erscheint dann unter Start → Add-ins.",
  "office_addins.restart_note":
    "LegalWork muss geöffnet sein, damit das Add-in funktioniert. Lass die App daher beim Arbeiten laufen.",
  "office_addins.restart_ok": "Verstanden",
  "office_addins.uninstall_prompt_title": "Sichere lokale Verbindung entfernen",
  "office_addins.uninstall_prompt_body":
    "Dies ist das letzte installierte Office-Add-in. LegalWork entfernt daher auch sein privates Zertifikat von deinem Mac. macOS fragt dabei eventuell einmalig nach deinem Passwort.",
  "office_addins.install_success": "Office-Add-in installiert. Starte Word/Excel/PowerPoint neu, falls geöffnet.",
  "office_addins.install_failed": "Das Office-Add-in konnte nicht installiert werden.",
  "office_addins.uninstall_success": "Office-Add-in entfernt.",
  "office_addins.uninstall_failed": "Das Office-Add-in konnte nicht entfernt werden.",
  "office_addins.install_hint":
    "Bei der Installation wird ein nur für localhost gültiges Zertifikat erzeugt und vom Betriebssystem als vertrauenswürdig eingestuft (eine Passwortabfrage); danach wird das Add-in zu deinen Office-Apps hinzugefügt.",

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
  "dashboard.change": "Ändern",
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
  "whats_new.title": "Neu in LegalWork",
  "whats_new.dismiss": "Verstanden",
  "whats_new.office.headline": "LegalWork, jetzt direkt in Microsoft Office",
  "whats_new.office.intro": "Entwerfen, prüfen und überarbeiten mit dem Agenten direkt neben deinem Dokument.",
  "whats_new.office.apps_title": "Add-ins für Word, Excel und PowerPoint",
  "whats_new.office.apps_body": "Öffne den Agenten in einer Seitenleiste in deinen Office-Apps und arbeite gemeinsam am geöffneten Dokument.",
  "whats_new.office.redline_title": "Änderungen als Redlines",
  "whats_new.office.redline_body": "In Word bearbeitet der Agent dein Dokument im Änderungsmodus. Du prüfst jede Änderung und nimmst sie an oder lehnst sie ab.",
  "whats_new.office.workspace_title": "Mit deinen Workspaces verbunden",
  "whats_new.office.workspace_body": "Die Seitenleiste erkennt, zu welchem Workspace ein Dokument gehört, und öffnet ihn automatisch.",
  "whats_new.office.cta": "Office-Add-ins öffnen",
  "word_addin.connecting": "Verbinde mit LegalWork...",
  "word_addin.connect_error_title": "LegalWork ist nicht erreichbar",
  "word_addin.connect_error_body": "Stelle sicher, dass der LegalWork-Server mit aktiviertem Word-Add-in läuft, und versuche es erneut.",
  "word_addin.connect_retry": "Erneut versuchen",
  "word_addin.open_legalwork": "LegalWork öffnen",
  "word_addin.workspaces_title": "Workspaces",
  "word_addin.new_workspace": "Neuer Workspace",
  "word_addin.workspace_name": "Name",
  "word_addin.workspace_folder": "Ordnerpfad",
  "word_addin.choose_folder": "Ordner auswählen…",
  "word_addin.no_folder_selected": "Noch kein Ordner ausgewählt.",
  "word_addin.create_in_file_folder": "Workspace im Ordner der Datei erstellen",
  "word_addin.create": "Erstellen",
  "word_addin.creating": "Wird erstellt…",
  "word_addin.cancel": "Abbrechen",
  "word_addin.no_workspaces": "Noch keine Workspaces. Erstelle einen, um loszulegen.",
  "word_addin.sessions_title": "Sessions",
  "word_addin.new_session": "Neue Session",
  "word_addin.no_sessions": "Noch keine Sessions. Starte eine neue über den +‑Button.",
  "word_addin.back": "Zurück",
  "word_addin.loading": "Wird geladen…",
  "word_addin.load_failed": "Daten konnten nicht von LegalWork geladen werden.",
  "word_addin.retry": "Erneut versuchen",
};

export default de;
