# Proposal: Mandanten, Mandate und Zusammenarbeit

**Status:** Diskussionsvorschlag / Draft. **Stand:** 23. Oktober 2026.

Legal Work soll die Kanzleistruktur mit Mandanten, Mandaten, Projekten und getrennten Team- und Finanzrechten abbilden. Die bestehende lokale Arbeitsweise bleibt die Grundlage. Dieser Vorschlag beschreibt das Zielmodell, die Bedeutung von Speichern und Synchronisieren, die Etappen der Umsetzung und deren Abnahmekriterien. Er behauptet keine bereits implementierten Zielgarantien.

Die zentralen Entscheidungen:

- Mehrere Projekte pro Mandant und pro Mandat; interne Projekte ohne künstlichen Mandanten.
- Stabile Mandatsidentität von Anfang an, ohne zusätzliche Pflichtmaske im einfachen Einprojektfall.
- Persönlich umschaltbare Sidebar: Projekte, nach Mandanten oder nach Mandaten gruppiert.
- Automatischer Sync gespeicherter nativer Projektdateien; bewusstes Zurückspeichern von DMS-Arbeitskopien.
- Keine Reservierung allein durch Öffnen; neue Versionen ersetzen keine bereits geöffnete Ansicht.
- Dokumentidentität und Versionierung als eigener Umbau, der die erste Mandantenübersicht nicht blockiert.

Der Vorschlag entwickelt die vorhandenen Verträge für [Projekt-Sync](../project-sync.md), [angebundene Speicher](../file-storage.md) und [Team-Speicher](../team-storage.md) weiter. Die konkreten Plattform- und Anbieterfähigkeiten sind vor der jeweiligen Implementierung zu prüfen. Finanzverwaltung, ein vollständiges DMS und ein streng verwalteter Offline-Cache sind keine Voraussetzungen für die erste Etappe.

## 1. Empfohlenes Fachmodell

### 1.1 Nutzeransicht und Datenmodell

**Ein Mandant kann mehrere Projekte haben.** Ein Projekt benötigt keinen Mandanten: freie Recherche und Kanzleiorganisation bleiben eigenständige Projekte mit leerer Mandantenzuordnung. Weder der Benutzername noch „Intern“ wird als künstlicher Mandant gespeichert. „Intern“ kann eine Projektart oder eine Anzeigegruppe sein. Eine leere Mandantenzuordnung entscheidet nicht über Eigentum oder Zugriff: Auch ein internes Projekt kann der Kanzlei gehören und mit einem Team geteilt sein; ein noch nicht zugeordnetes Projekt ist nicht automatisch intern.

Die Sidebar erhält eine persönliche Ansichtswahl: **Projekte**, **nach Mandanten** und, soweit fachlich verwendet, **nach Mandaten**. Gruppierung und Sortierung ändern weder Identitäten noch Freigaben. Eine mögliche Ansicht „nach Mandanten“:

```text
Kanzlei
├── Muster GmbH
│   ├── Unternehmenskauf 2026
│   ├── Arbeitsrechtliche Beratung
│   └── Rechtsstreit Lieferant X
├── Weitere Mandanten …
└── Ohne Mandant
    ├── Freie Recherche
    └── Kanzleiorganisation
```

Begrifflich ist der Mandant die Person oder das Unternehmen, das Mandat der konkrete Auftrag/Fall und das Projekt der Arbeitskontext in Legal Work. **Das Mandat erhält bereits im ersten Ausbau eine stabile Identität.** Häufig deckt ein Projekt genau ein Mandat ab. Dafür verlangt die Oberfläche keine doppelte Anlage: Wird einem neuen Projekt ein Mandant zugeordnet, entsteht im Hintergrund ein neues Mandat oder es wird bewusst ein vorhandenes ausgewählt. Ein gleicher Mandantenname führt niemals automatisch dazu, dass zwei Projekte dasselbe Mandat teilen. Mehrere Projekte können zum selben Mandat gehören, etwa „Due Diligence“ und „Verhandlung“. Die zusätzliche Navigationsebene kann im einfachen Einprojektfall verborgen bleiben.

Eine Mandatsübersicht kann Beteiligte, Verantwortliche, Projekte, Dokumente, Aufgaben, Fristen und – soweit berechtigt – Budget und Leistungen bündeln. Technische Fenster, Tabs und wiederherstellbare Layouts sind davon unabhängig: Ein zusätzlich geöffneter Workspace erzeugt weder ein neues Mandat noch neue Rechte oder eine Dokumentreservierung.

| Objekt | Aufgabe |
|---|---|
| Kanzlei / Organisation | Sicherheits-, Verwaltungs- und Zuständigkeitsgrenze. |
| Mandant / Person / Unternehmen | Wiederverwendbare Identität, Kontakte, Kennungen, Beziehungen. |
| Mandat / Akte | Fachlicher Auftrag mit Aktenzeichen, Lebenszyklus, Team, Richtlinien und Finanzbezug. |
| Mandatsbeteiligter | Verknüpft eine Person/Organisation in einer Rolle: Mandant, Gegner, Gericht, Versicherer, Kontakt, Rechnungsempfänger. |
| Projekt | Arbeitskontext mit optionaler Mandatsreferenz. Seine Mandanten ergeben sich aus diesem Mandat; kein unabhängiges, widersprüchliches Mandantenfeld. Auch intern oder noch nicht zugeordnet möglich. |
| Fenster / Tabs / Workspace-Layout | Persönliche Ansicht auf bestehende Projekte und Dokumente; keine fachliche Eigentums- oder Berechtigungsgrenze. |
| Dokument und Dokumentversion | Dauerhafte Identität sowie nachvollziehbare Fassungen; unabhängig vom Dateinamen. |
| Teamzuordnung | Person/Gruppe, Zuständigkeit, Berechtigungsrolle und Gültigkeitszeitraum. |
| Leistung / Abrechnung | Fachliche Finanzobjekte mit eigener Berechtigung und Freigabestatus. |

Der sichtbare Baum ist nicht das vollständige Datenmodell. Ein Mandat kann mehrere Mandanten haben; eine Versicherung kann Rechnungsempfänger sein, ohne Mandant zu sein. Ein Konzern kann mehrere eigenständige Mandanten enthalten. Ein gemeinsamer Konzernknoten darf nicht automatisch alle Mandate für alle Teams öffnen.

Für den ersten Ausbau gelten diese Beziehungen:

- Ein Projekt gehört zu **höchstens einem Mandat**, ein Mandat kann mehrere Projekte enthalten.
- Ein Mandat kann **mehrere Mandanten** über Beteiligtenbeziehungen haben. Die erste Oberfläche kann mit einem Mandanten beginnen, das Datenmodell darf die Mehrfachbeziehung nicht ausschließen.
- Interne und noch nicht zugeordnete Projekte haben eine leere Mandatsreferenz und damit keine abgeleitete Mandantenzuordnung. Ihre Kanzleizugehörigkeit und Freigaben bestehen unabhängig davon.
- Die Sidebar darf dasselbe Projekt bei mehreren berechtigten Mandanten anzeigen; es bleiben Verweise auf dieselbe Projekt-ID, keine Kopien. Zähler berücksichtigen nur sichtbare, eindeutige Projekte.
- Zusammenführen von Mandanten und Umhängen von Projekten sind nachvollziehbare Verwaltungsaktionen. Sie ändern weder still die Freigaben noch rückwirkend den Mandatsbezug bereits erfasster Leistungen. Namen, Identitäten und lokale Dateipfade bleiben getrennt.

Damit ist die fachliche Identität früh festgelegt. Offen bleibt die Gestaltung der sichtbaren Mandatsübersicht, nicht die Existenz des Mandats im Datenmodell.

### 1.2 Drei getrennte Rollenfragen

**Kanzleifunktion:** Darf eine Person Benutzer, Integrationen, Finanzkonfiguration oder Sicherheitsregeln verwalten?

**Mandatszuständigkeit:** Ist sie Relationship Partner, verantwortlicher Partner, Billing Partner, Associate, Assistenz oder externer Mitarbeiter dieses Mandats?

**Konkretes Recht:** Darf sie Dokumente lesen, bearbeiten, herunterladen, teilen, Teammitglieder verwalten, eigene Zeiten erfassen, Leistungen freigeben oder Rechnungen versenden?

„Partner“ ist eine berufliche Funktion, keine automatische Leseberechtigung für jedes Mandat. „Mandant betreuen“ ist ebenfalls nicht dasselbe wie „alle Mandate dieses Mandanten sehen“.

Empfohlene Standardvorlagen:

| Rolle im jeweiligen Geltungsbereich | Dokumentinhalt | Team / Freigabe | Leistungen / Finanzen |
|---|---|---|---|
| IT-/Organisationsadmin | Kein automatischer Inhaltszugriff | Benutzer und technische Konfiguration; begrenzte Verwaltungsrechte | Kein automatischer Honorarzugriff |
| Mandatsverantwortlicher Partner | Freigegebene Mandatsinhalte | Team und zulässige Delegationen | Mandatsbudget und gesondert zugewiesene Freigaben |
| Bearbeiter / Associate | Lesen und bearbeiten | Standardmäßig kein Recht, Zugriff zu erweitern | Eigene Leistungen erfassen und einreichen |
| Assistenz | Nach Aufgabenprofil | Keine automatische Rechteverwaltung | Eigene/zugewiesene Erfassung, Fristenrechte separat |
| Billing-Mitarbeiter | Nur bei zusätzlicher Inhaltsfreigabe | Keine | Erforderliche Mandatskennungen, Leistungs- und Rechnungsbearbeitung |
| Billing Partner | Nur bei zusätzlicher Inhaltsfreigabe | Keine automatische | Freigabe definierter Mandatsabrechnungen und Korrekturen |
| Finance Admin | Kein pauschaler Dokumentzugriff | Finanzrollen und Konfiguration | Honorarsätze, Finanzprozesse und Auswertungen nach Scope |
| Externer / Mandant | Explizit freigegebener Ausschnitt | Keine Weiterfreigabe als Default | Keine internen Finanz-/Leistungsdaten |

Mehrere Rollen können einer Person gemeinsam zugewiesen werden. Die Rechte aus Rollen werden gesammelt, aber ausdrückliche Sperren, DMS-Beschränkungen und Informationsbarrieren haben Vorrang. Ein dokumentierter Notfallzugriff sollte eng befristet und protokolliert sein, kein unsichtbarer Superadmin-Bypass.

Das Recht, eine fremde Dokumentreservierung aufzuheben, ist eine eigene delegierbare Befugnis mit Begründung und Protokollierung. Sie ist kein allgemeines IT-Adminrecht. Eine Aufhebung verwirft keine Entwürfe und berechtigt den früheren Reservierungsinhaber nicht, später einen neueren Stand zu überschreiben.

### 1.3 Ein einheitlicher Entscheidungsweg

Für jeden Zugriff wird dieselbe Entscheidung benötigt – in der Oberfläche, im Sync, bei der Suche, im Export und im Agenten:

**Erlaubte Rollenaktion im passenden Scope + gültige Mitgliedschaft + erlaubte Daten-/Geräterichtlinie + Berechtigung des Quellsystems; keine entgegenstehende Sperre.**

Finanzrechte bekommen einen eigenen Datenumfang. Billing darf beispielsweise Aktennummer, Rechnungsempfänger, notwendige Leistungstexte und Beträge sehen, ohne dadurch Zugang zu Schriftsätzen oder Strategie-Chats zu erhalten. Besonders geschützte Leistungsbeschreibungen können eine nochmals engere Sicht erfordern.

Volltextindizes, Embeddings, Vorschauen, Exporte, Chat-Anhänge und KI-Zusammenfassungen brauchen dieselben Schutzbezüge wie ihre Quellen. Ein Kanzlei-Wiki darf nicht zum Umweg um eine Mandatssperre werden. Für wiederverwendbares Wissen braucht es eine bewusste Freigabe oder Bereinigung; bei mehreren Quellen gilt ohne solche Freigabe die restriktive Kombination ihrer Schutzregeln. Schon Trefferzahlen, Dateinamen und Benachrichtigungen können geschützte Informationen offenlegen.

### 1.4 Mandantenstamm, lokale Anlage und Sichtbarkeit

Mandanten, Mandate und ihre Beziehungen sind **Organisationsdaten mit eigener lokaler Replik und Ausgangswarteschlange**. Die Mandatszuordnung ist ein kontrolliertes Attribut des Projekts, unabhängig vom optionalen Sync-Schalter für freie Projektdetails. Eine lokale Kopie der Zuordnung hilft bei Wiederherstellung; sie ist keine zweite unabhängig bearbeitbare Wahrheit.

Für bereits berechtigte Kanzleimitglieder ist die Anlage auch offline möglich: lokal erzeugte IDs und wiederholbar übertragbare Operationen verhindern doppelte Datensätze nach Verbindungsabbrüchen. Abhängige Vorgänge werden in der Reihenfolge Mandant → Mandat/Beteiligte → Projektzuordnung übertragen. Vor Annahme prüft der Server die aktuellen Rechte. Wird eine Offline-Anlage abgewiesen, bleibt sie als gekennzeichneter lokaler Entwurf zur Klärung erhalten und erscheint nicht als erfolgreich geteiltes Kanzleimandat. Namensgleichheit erzeugt einen Vorschlag zur Zusammenführung, keinen automatischen Merge; konkurrierende Zuordnungsänderungen benötigen eine Versionsprüfung.

Die lokale Replik enthält nur den zulässigen Ausschnitt. Ein Organisationsstamm bedeutet nicht, dass jedes Mitglied sämtliche Mandanten, Mandate oder Beziehungen auflisten kann. Für die erste Sidebar werden nur die minimal erforderlichen Stammdaten zu sichtbaren Projekten geliefert; eine umfassende Mandantenverwaltung erhält eigene Rechte. Die Auswahl, Suche, Zähler und Offline-Replik dürfen keine verborgenen Mandate verraten.

Im ersten Ausbau bleiben bestehende Projektfreigaben maßgeblich. Das gemeinsame Mandat verbindet Projekte fachlich, ohne deren Teams automatisch zu vereinigen. Eine spätere Vererbung von Mandatsrechten auf Projekte braucht eine ausdrückliche Regel und Migration; das Umhängen eines Projekts ist kein stiller Zugriffserweiterungsmechanismus.

## 2. Offline und gemeinsames Arbeiten konkret lösen

### 2.1 Rechte, Verfügbarkeit und Reservierung bleiben unabhängig

Pro Dokument werden Zugriff, tatsächliche lokale Verfügbarkeit, führendes Speichersystem, Bearbeitungs-/Reservierungszustand und erlaubte KI-Verarbeitung getrennt geführt. Ein Download erteilt keine zusätzlichen Rechte, eine offene Ansicht reserviert nichts, und Dateisync macht kein Cloud-Modell offline ausführbar.

**Offline-Arbeit ist kein gesonderter Pflichtablauf.** Bereits vollständig lokal vorhandene und zur Offline-Nutzung erlaubte Inhalte bleiben bei Verbindungsverlust verwendbar. Lokale Änderungen werden gesichert und später abgeglichen. Native lokale Projekte benötigen keinen vorbereitenden Download. „Offline behalten“ ist eine zusätzliche Möglichkeit für Cloud-/DMS-Inhalte: vollständig herunterladen und nicht automatisch aus dem Cache entfernen. Noch ausstehende Downloads sind sichtbar. Ein Projekt darf nicht pauschal als vollständig offline verfügbar erscheinen, wenn Inhalte fehlen.

### 2.2 Festgelegte Bedeutung von Sichern, Speichern und Teilen

Der Plan unterscheidet die automatische **Wiederherstellungssicherung des Editors** von einem **Speichern in die Arbeitsdatei**. Die Wiederherstellungssicherung schützt den aktuellen Entwurf außerhalb des normalen Dateisyncs; sie wird nicht allein durch diese Sicherung zur Teamversion. Sie ersetzt keine Sicherung des gesamten Geräts und ist kein allgemeines Versprechen über andere Cloud-/Backup-Funktionen.

| Betriebsart | Was bedeutet Speichern? | Was wird gemeinsam verfügbar? |
|---|---|---|
| Rein lokales Projekt | Manuelles Speichern oder aktiviertes Autosave aktualisiert die lokale Datei. | Ohne Freigabe kein Team-Sync. |
| Natives geteiltes Projekt | Speichern aktualisiert die Projektdatei und stellt ihre Änderung für den Sync bereit. Aktiviertes Autosave hat dieselbe Bedeutung. | Die Änderung wird nach erfolgreicher Versions- und Rechteprüfung automatisch übertragen; kein zusätzlicher Freigabeklick pro normalem Speichern. |
| DMS-/angebundenes Dokument mit Arbeitskopie | Speichern und Autosave sichern zunächst die kontrollierte lokale Arbeitskopie. | „Im DMS speichern“ beziehungsweise „Zurückspeichern“ erzeugt nach Prüfung die neue Fassung im führenden System. |

**Eine gespeicherte Datei im geteilten Projektordner ist keine private Entwurfsablage.** „Lokal gespeichert – Übertragung ausstehend“ beschreibt dort nur einen Übertragungszustand, etwa offline oder bei einem Konflikt. Die Datei ist zur Weitergabe vorgesehen. Ein künftig ausdrücklich privater Entwurfsmodus müsste eine getrennte, vom Team-Sync ausgeschlossene Ablage mit denselben fachlichen Schutzbezügen verwenden; er gehört nicht automatisch zum ersten Ausbau.

Diese Entscheidung erhält die normale Arbeit mit Projektdateien. Änderungen durch externe Programme im geteilten Ordner sind ebenfalls zur Synchronisierung vorgesehen. Der vorhandene Datei-Autosave ist dabei von einer zukünftigen durchgängigen Wiederherstellungssicherung zu unterscheiden; deren Schutz muss für jeden unterstützten Editor nachgewiesen werden. Autosave wird durch diesen Plan nicht still für alle Nutzer eingeschaltet. Die Oberfläche zeigt bei seiner Aktivierung, ob es die geteilte Projektdatei oder nur eine DMS-Arbeitskopie aktualisiert.

Gemeinsames Speichern ist keine fachliche Freigabe eines Schriftsatzes und kein Versenden an Mandanten. Solche Freigaben bleiben eigene Vorgänge. Ebenso sind Hintergrundübertragung und Übernahme einer neuen Fassung in einen geöffneten Editor verschiedene Aktionen.

### 2.3 Offene Ansichten, Aktivität und sämtliche Schreiber

**Ein offener Tab reserviert nichts.** Im Zielverhalten erwerben wiederhergestellte oder nur lesende Ansichten keine Schreibzuständigkeit. Die heutige Fensterkoordination fordert sie bereits beim Start an; das ist ein konkreter Änderungsbedarf, kein Widerspruch zur Zielvorgabe.

**Eigene Fenster:** Vor der ersten tatsächlichen Änderung wird eine lokale Schreibzuständigkeit erworben. Eingaben dürfen währenddessen weder verloren gehen noch bereits unkoordiniert in die Datei geschrieben werden. Ein inaktiver, sauberer Editor hält diese Zuständigkeit nicht unnötig fest: Sind keine Änderungen oder laufenden Schreibvorgänge mehr offen, erfolgt die Übernahme ohne Dialog. Existiert dagegen ein anderer Editor mit eigenen Änderungen, wird dessen gesicherter Entwurf ausdrücklich übernommen oder die bisherige Bearbeitung bleibt zuständig. Ein Fokuswechsel veröffentlicht oder verwirft nichts. Eine inzwischen geänderte Basis wird angezeigt, bevor der alte Stand wieder in die Datei geschrieben werden kann. Gemeinsame Live-Editor-Sitzungen in mehreren Fenstern sind ein möglicher späterer Ausbau, keine Voraussetzung.

**Andere Personen und eigene weitere Geräte:** Standard ist ein Hinweis auf bekannte aktuelle Bearbeitung, mit bewusstem Fortsetzen als eigene Fassung. Dieselbe Person auf einem zweiten Gerät wird wie ein weiterer Schreiber behandelt; Gerät und Sitzung sind unterscheidbar. Harte Reservierungen bleiben ein gezieltes Opt-in beziehungsweise eine Vorgabe des DMS. Unveröffentlichte Entwürfe allein verursachen keine unbefristete Team-Sperre. Welche Kanzleirichtlinien künftig eine Reservierung verlangen dürfen, bleibt eine gesonderte Produktentscheidung.

Dafür wird ein neuer, zugriffsgeschützter Aktivitätskanal benötigt. Er enthält Dokumentbezug, handelnde Person, Gerät/Sitzung, gegebenenfalls Agent im Auftrag dieser Person, bekannte Basisversion und Ablaufzeit. Ein Hinweis auf ungespeicherte Änderungen wird nur gemeldet, wenn der betreffende Editor diesen Zustand kennt. Reine Dateiüberwachung weiß nicht, ob in einer externen Word-Instanz noch ungespeicherte Eingaben liegen.

Als erste technische Vorgabe kann eine aktive Sitzung etwa alle 20 Sekunden melden und nach spätestens 60 Sekunden ohne Aktualisierung als nicht mehr aktuell gelten; dies ist zu erproben, keine Garantie über tatsächliche Anwesenheit. Ein unberührter Hintergrund-Tab erneuert keinen aktiven Bearbeitungsstatus endlos. Ablauf der Anzeige löscht keinen Entwurf. Die Aussage lautet dann „keine aktuelle Aktivität bekannt“, niemals „niemand bearbeitet“. Eine offline begonnene Änderung ist vor Wiederverbindung für andere unbekannt. Der Aktivitätskanal überträgt keine Dokumentinhalte und erteilt keine Zugriffsrechte.

**Agenten und externe Programme:** Ein Agent ist ein Schreiber mit Identität und Auftraggeber. Er darf nicht über einen anderen Schreibweg die Basisprüfung oder eine Reservierung umgehen. Bearbeitet ein Mensch gerade, erzeugt der Agent standardmäßig eine Vorschlagsfassung mit Quellenbezug. Externe Programme, die über Legal Work geöffnet werden, benötigen eine überwachte Arbeitskopie mit festgehaltener Basis. Direkte Schreibzugriffe beliebiger Programme in einen frei zugänglichen Ordner lassen sich nicht durch eine reine UI-Sperre kontrollieren; die Grenzen stehen in Abschnitt 2.4.

**Neue Version bei geöffneter Ansicht:** Auch ein sauberer Editor bleibt auf seiner angezeigten Fassung, bis die Person „vergleichen“ oder „übernehmen“ wählt. Bei eigenen Änderungen bleiben Entwurf und Basis erhalten. Eingehende Dateien dürfen im Hintergrund bereitgestellt und ungeöffnete Dateien normal aktualisiert werden; ein Editor muss dafür eine eigene, beständige Basis halten und darf nicht aus der gerade vom Sync ersetzten Datei unbemerkt nachladen. Eine blockierte Veröffentlichung beendet nicht die lokale Entwurfssicherung. Echtes Co-authoring wäre ein ausdrücklich erkennbarer Modus mit anderer Aktualisierungslogik.

### 2.4 Dokumentidentität und Veröffentlichung als eigener Architekturbaustein

**Stabile Dokument-IDs bleiben auch für native Legal-Work-Dateien das Ziel.** Ein Pfad ist ein veränderlicher Ablageort; ein Inhalts-Hash prüft Inhalt und Übertragung. Beides ersetzt keine dauerhafte Dokumentidentität. Eine Wiederherstellung eines früheren Inhalts erzeugt eine neue Version mit neuem Ereignis und Herkunft, auch wenn der Inhalts-Hash schon einmal vorkam.

Der Versionsvertrag umfasst mindestens:

- Dokument-ID, unveränderliche Versionsreferenz, vorherige beziehungsweise bearbeitete Basis, Inhalt/Prüfsumme, Person oder Agent, Zeitpunkt und Quellenbezug.
- Eine Prüfung von aktuellem Zugriff, relevanter Reservierung und erwarteter Basis beim verbindlichen Commit. Prüfung und Annahme dürfen nicht durch einen dazwischenliegenden Schreibvorgang oder Rechteentzug auseinanderfallen.
- Eine dauerhafte Operations-ID pro Speichervorgang. Nach Abbruch oder verlorener Bestätigung kann derselbe Vorgang wiederholt oder abgefragt werden, ohne eine zweite Veröffentlichung zu erzeugen. Ein unvollständiger Upload ist noch keine sichtbare Version.
- Einen erhaltenen lokalen Entwurf bei Abweisung, Vergleich mit der gemeinsamen Basis und eine ausdrücklich erzeugte Konfliktauflösung. Auch „meine Fassung verwenden“ prüft den dann aktuellen Stand erneut; es ist kein allgemeiner Force-Overwrite.
- Umbenennen/Verschieben als Änderung der Ablagezuordnung und Löschen als nachvollziehbaren Zustand. Gleichzeitiges Bearbeiten und Löschen wird sichtbar geklärt; Versionen und Entwürfe verschwinden dabei nicht still.

Das erfordert Änderungen an Plattformvertrag, lokalem Dokumentregister, Sync, Editorbasis, Wiederherstellung und Fensterkoordination. Es ist **kein kleines Ergänzen von Metadaten**. Übertragung, Warteschlangen und Prüfsummen des bisherigen Syncs können weiterverwendet werden; seine pfadbasierten Abgleichs- und Konfliktregeln müssen gezielt weiterentwickelt werden.

Für Umbenennungen außerhalb der App braucht es einen Pfad-ID-Abgleich. Identischer Inhalt allein beweist keine Identität: Eine Kopie kann denselben Hash haben, und ein umbenanntes Dokument kann gleichzeitig verändert werden. Nur eindeutig belegte Vorgänge werden automatisch zugeordnet; unklare Fälle werden zur Entscheidung vorgelegt. Eine vorgeschaltete Historie je Pfad kann ein begrenzter Schutzgewinn sein, darf aber nicht als Erfüllung der Dokumentidentitätsziele verkauft werden.

**Grenze frei zugänglicher Ordner:** Zwei beliebige externe Programme können zwischen Beobachtungen dieselbe Datei überschreiben. Ein Watcher und eine Serverprüfung können eine zuvor unbemerkt verlorene lokale Fassung nicht wiederherstellen. Die starke Zusage „keine verlorenen konkurrierenden Änderungen“ gilt daher für kontrollierte Legal-Work-Schreibwege und integrierte externe Arbeitskopien. Direkter Zugriff im Dateisystem bleibt möglich, erhält aber nur den nachgewiesenen Beobachtungs-/Sicherungsschutz. Eine strengere Garantie benötigt einen kontrollierten Speicherzugang; sie wird nicht ohne Nachweis behauptet. Dasselbe gilt für Speicheradapter ohne atomare Versionsvorbedingung gegenüber fremden Schreibern.

### 2.5 Verhalten in den entscheidenden Konfliktfällen

| Situation | Zielverhalten |
|---|---|
| Viele offene Tabs, keine Bearbeitung | Keine Reservierung; Lesen und spätere Bearbeitung in anderen Fenstern bleiben möglich. |
| Zwei eigene Fenster beginnen zu ändern | Lokale Koordination vor dem Schreiben; sichere Übergabe oder getrennte Vorschlagsfassung, kein verworfener Entwurf. |
| Zwei Personen oder zwei eigene Geräte ändern dieselbe Basis | Aktivität ist nur Hinweis. Die verbindliche Versionsprüfung nimmt einen Stand an; der andere bleibt als eigene Fassung zur Entscheidung erhalten. |
| Eine Person arbeitet offline, eine andere veröffentlicht online | Beide Fassungen und die gemeinsame Basis bleiben erhalten. Kein automatisches Überschreiben bei Wiederverbindung. |
| Eine neue gemeinsame Version trifft bei geöffneter Ansicht ein | Anzeige „Neue Version verfügbar“; weder saubere Ansicht noch eigener Entwurf werden still ersetzt. |
| Agent arbeitet an einem vom Menschen bearbeiteten Dokument | Vorschlagsfassung statt Überschreiben; Auftraggeber und Basis sind erkennbar. |
| Speichern wurde angenommen, die Bestätigung geht verloren | Wiederholung derselben Operations-ID bestätigt denselben Commit statt einer zweiten Veröffentlichung. |
| Reservierung läuft ab oder wird aufgehoben | Entwurf bleibt erhalten; spätere Veröffentlichung prüft die aktuelle Berechtigung, Reservierungsgeneration und Basis erneut. |
| Datei wird umbenannt oder gelöscht, während ein anderes Gerät sie ändert | Stabile Identität beziehungsweise ausdrückliche Zuordnungsentscheidung; kein stilles Duplikat und kein Verlust der Bearbeitung. |

Eine verbindliche Reservierung kann nur online bei der maßgeblichen Instanz erworben werden. Offline entsteht daraus keine neue globale Exklusivität. Reservierungsdauer, Verlängerung und protokollierte Aufhebung sind getrennt von der kurzlebigen Aktivitätsanzeige. Verlangt das DMS einen Checkout, gelten dessen Regeln; Legal Work simuliert keine unabhängige zweite Sperrverwaltung.

### 2.6 Führendes System und Anbieterfähigkeiten

**Native Legal-Work-Dokumente:** Die Plattform führt die gemeinsame, versionierte Fassung; lokale Dateien bleiben die zugängliche Arbeitsdarstellung. Der Ausbau aus Abschnitt 2.4 ist dafür erst umzusetzen. Ein bereits existierender Dateisync ist kein Nachweis eines vollständigen Versionsarchivs.

**DMS-Dokumente:** Das DMS führt Rechte, Identität und Versionen. Legal Work hält stabile Referenzen, zulässige Metadaten und Arbeitskopien. Bibliothek/Repository, Dokument-ID, Version und Aktenbezug bleiben erhalten. DMS-Arbeitskopien werden vom zweiten Team-Dateisync ausgeschlossen. Zurückspeichern, neue eigenständige Datei und private Wiederherstellungssicherung sind unterscheidbare Vorgänge.

**Einfache Dateispeicher:** Ein generischer Adapter ohne DMS-Fähigkeiten bleibt nutzbar. Er wird nicht als vollwertige Akten-, Reservierungs- oder Versionsintegration dargestellt. Pro Anbieter werden Identität, Rechteprüfung, Versionsvorbedingung, Historie, Reservierung, Änderungserkennung und Offline-Arbeitskopie als unterstützte oder fehlende Fähigkeiten geführt.

Connectoren handeln mit der Identität und den Rechten der jeweiligen Person. Allgemein berechtigte Sammelkonten dürfen persönliche Informationsbarrieren nicht aufheben. Die bestehenden in der Anwendung engeren Regeln für Teamkonten ersetzen keine benutzerbezogene DMS-Authentifizierung. [Dokumentierte Team-Speichergrenzen](../team-storage.md).

### 2.7 Rechteentzug, geschützte Übergabe und spätere Cache-Option

Beim Rechteentzug stoppen verbundene Geräte weitere zulässigkeitsabhängige Zugriffe. Ein vollständig getrenntes Gerät kann nicht sofort erreicht werden. Bei normalen Klartextdateien lässt sich außerdem keine verbindliche Offline-Ablauffrist allein durch die App durchsetzen. „Zugriff beendet“, „von der App-Kopie entfernt“ und „sämtliche Kopien gelöscht“ sind verschiedene Aussagen; die letzte ist für Exporte und eigene Ordner nicht belegbar.

Für kanzleiverwaltete Daten ist ungesendete Arbeit geschützt an berechtigte Verantwortliche zu übergeben. Dazu braucht es einen **separaten, eng begrenzten Annahmekanal**, der keine erneuten Lese-, Listen- oder Projektbearbeitungsrechte erteilt. Eine Übergabeberechtigung wird an Organisation, Identität, zulässige Dokumentbezüge, Zweck und Laufzeit gebunden. Sie nimmt eine unbestätigte Fassung in Quarantäne auf, veröffentlicht sie nicht als gültige Dokumentversion. Die Übernahme durch eine berechtigte Person wird protokolliert. Fehlt nach Kontosperre ein authentifizierbarer Übergabekanal, bleibt eine gesicherte lokale Wiederherstellung mit administrativ organisiertem Übergabeweg erforderlich; vollständige Automatik darf dann nicht versprochen werden.

Bestehende eigene Projektordner werden durch eine neue Mandantenzuordnung weder enteignet noch gelöscht. Für deren Umwandlung in einen streng verwalteten Bereich braucht es eine ausdrückliche Migration mit klaren Kopier-/Exportgrenzen. Bis dahin wird die begrenzte Rückrufwirkung offen angezeigt. Organisationsbesitz und die nötigen Administrationsrechte sind Voraussetzung für die neue Übergabelogik.

Ein gerätegebundener, verschlüsselter Cache mit Offline-Berechtigungsdauer bleibt eine **spätere gesonderte Option**, zunächst besonders für DMS-Arbeitskopien. Er ist nicht Voraussetzung für die Mandantenübersicht. Vor Einführung sind externe Office-Bearbeitung, Agentenzugriff, Wiederherstellung und Schlüsselverwaltung nachzuweisen. Ein solcher Cache ist grundsätzlich mit automatischer Offline-Arbeit vereinbar; er erfordert aber einen eigenen Integrationsentwurf. Vollverschlüsselung des Geräts kann Schutz bei Geräteverlust beitragen, ersetzt weder Dateirechte noch einen Rückruf bereits exportierter Inhalte.

## 3. Zeiterfassung und spätere Kanzleifunktionen vorbereiten

Abrechenbare Zeiterfassung sollte an das **Mandat**, die leistende Person und gegebenenfalls Projekt und konkreten Arbeitsvorgang gebunden sein. Interne Zeiten können einem internen Projekt ohne Mandant zugeordnet werden und benötigen keinen künstlichen Kunden. Mandant, Rechnungsempfänger und Billing Partner sind getrennte Referenzen. Eine Leistung benötigt mindestens Datum, Dauer/Menge, Tätigkeit, Beschreibung, Verrechenbarkeit, Status und Herkunft. Sätze und Tarifregeln brauchen eigene Versionen beziehungsweise den bei Freigabe festgehaltenen Stand.

Sinnvoller Ablauf:

**Entwurf → eingereicht → geprüft/freigegeben → abgerechnet → gegebenenfalls nachvollziehbar korrigiert.**

Ein Associate kann eigene Zeiten erfassen, ohne fremde Honorarsätze zu sehen. Billing kann Leistungen aufbereiten; der zuständige Partner genehmigt den vorgesehenen Umfang. Bereits abgerechnete Leistungen werden nicht unbemerkt überschrieben. Für Finanzdaten ist „die letzte Änderung gewinnt“ kein ausreichendes Sync-Verfahren.

Offline-Erfassung erzeugt lokale, eindeutig identifizierte Ereignisse. Beim Wiederverbinden werden sie genau einmal übernommen. Änderungen an bereits eingereichten oder freigegebenen Positionen lösen eine kontrollierte Revision aus. Mehrere Geräte dürfen nicht dieselben Minuten doppelt abrechnen. KI kann aus Arbeitsschritten Leistungsvorschläge erzeugen, aber Laufzeit eines Agenten ist nicht automatisch abrechenbare Anwaltszeit.

Weitere anschlussfähige Bereiche sind Mandatsannahme und Kollisionsprüfung, Kontakte/Beteiligte, Budgets, Fristen mit Vier-Augen-Freigabe, Korrespondenzzuordnung, Mandantenportale, Signaturen, Archivierung und Aufbewahrung. Bestehende Buchhaltung, ERV und Honorarlogik würde ich zunächst anbinden. Österreichische Abrechnung und Gerichtskommunikation sind eigenständige Fachprodukte; sie sollten nicht beiläufig als Teil des ersten Organisationsumbaus entstehen.

## 4. Umsetzung in abgegrenzten Etappen

### Schritt 1: Mandantenübersicht mit belastbarer fachlicher Identität

Die vorhandene Organisation wiederverwenden. Mandanten, Mandate, deren Mandantenbeziehungen und die optionale Mandatsreferenz am Projekt von Anfang an mit stabilen IDs führen. Die Oberfläche bietet „vorhandener Mandant“, „neuer Mandant“ und „kein Mandant“; ein vorhandenes Mandat kann ausdrücklich gewählt werden. Im einfachen Fall entsteht das Mandat im Hintergrund. Keine zusätzliche Pflichtmaske, kein Pseudomandant, keine automatische Zusammenlegung gleicher Namen.

Dazu gehören die Sidebar-Ansichten, die auf sichtbare Projekte begrenzte Stammdatensicht, lokale Replik und Ausgangswarteschlange aus Abschnitt 1.4. Die Zuordnung bleibt unabhängig vom optionalen Projektdetails-Sync. Eine erste Zuordnung bestehender Projekte kann manuell erfolgen; ein intelligenter Migrationsassistent ist kein notwendiger Bestandteil dieses Schritts. Projektreferenzen, Dateipfade und bestehende Freigaben ändern sich nicht still.

**Abgrenzung:** Neue fachliche Struktur, noch keine neue Vererbung von Mandatsrechten, kein Dokumentversionssystem, keine Anwesenheitsanzeige und keine Finanzverwaltung. Die Projektberechtigungen schützen auch die erste Navigation. Eine Organisationstabelle darf nicht versehentlich zum frei zugänglichen Verzeichnis aller Mandate werden.

Vor der Umsetzung ist der Vertrag im tatsächlichen `model-api`-Backend zu prüfen. Die Zahl benötigter Tabellen, Endpunkte und Migrationen ist aus dem bestehenden Backendmodell und den hier beschriebenen Anforderungen abzuleiten; sie wird durch diesen Vorschlag nicht vorweggenommen.

### Schritt 2: Kanzleibesitz, Teams und Rechte verbindlich machen

Kanzleimandate organisatorisch besitzen lassen, mit übertragbarer Verantwortung. Projekt-Ersteller, verantwortlicher Partner und Berechtigungsverwaltung bleiben getrennt. Das Ausscheiden einer Person darf keine Akten verwaisen lassen. Die Migration bestehender persönlicher Projektverantwortung erfolgt ausdrücklich.

Mandatsrollen und projektspezifische Einschränkungen erhalten einen dokumentierten Vererbungsvertrag. Bestehende Freigaben werden nicht durch die Zuordnung zu einem gemeinsamen Mandat erweitert. Lesen, Bearbeiten, Teamverwaltung, Teilen, Offline-Kopien, Finanzdaten und Aufheben einer Reservierung werden getrennt geprüft. Die Schutzentscheidung gilt für API, Sync, Suche, Export und Agenten. Hier werden auch der geschützte Übergabekanal und der Umgang mit Rechteentzug aus Abschnitt 2.7 spezifiziert; eine strengere Rückrufgarantie wird erst nach entsprechender Abnahme angeboten.

### Schritt 3A: Editorverhalten und sichere lokale Wiederherstellung

Kann parallel zur fachlichen Navigation beginnen. Wiederherstellungssicherung und Veröffentlichung klar trennen. Aktive Ansichten auf ihrer Basis halten, eingehende Versionen anzeigen, Entwürfe bei Konflikt und Absturz erhalten. Lokale Schreibzuständigkeit erst bei tatsächlicher Bearbeitung erwerben, sichere Übergabe zwischen eigenen Fenstern prüfen. Agenten sollen bei aktiver menschlicher Bearbeitung Vorschlagsfassungen erzeugen.

Die verbleibenden Grenzen des alten Dateisyncs und frei zugänglicher Ordner bleiben sichtbar. Diese Etappe behauptet weder ein neues unveränderliches Serverarchiv noch vollständige Identitätserhaltung bei externen Umbenennungen. Temporäre bestehende Pfadschlüssel werden bei Einführung der Dokument-IDs nachvollziehbar migriert; aktive Entwürfe dürfen dabei nicht verloren gehen.

### Schritt 3B: Versions- und Identitätsvertrag für native Dokumente

Eigener technischer Entwurf und eigener Implementierungsumfang: Dokumentregister, IDs, unveränderliche Versionen, idempotente Veröffentlichungen, Rechte-/Basisprüfung, Pfadzuordnung, Konflikt- und Löschzustände. Erst nach Prüfung der tatsächlichen Plattformfähigkeiten den Umbau von Client und Backend zuschneiden. Die Vorgaben aus Abschnitt 2.4 gelten als Abnahmekriterien.

Die Migration braucht einen Pilot mit bestehenden Projekten und einen Wiederherstellungsweg. Alte und neue Clients dürfen dieselbe Datei nicht über widersprüchliche Commit-Verträge bearbeiten; je Projekt wird vor Aktivierung geklärt, welche Clientversionen weiter schreiben dürfen. Ein versionsunfähiger Client wird gegebenenfalls auf Lesen beschränkt oder benötigt ein Update. Keine stille Umschaltung laufender Projekte.

Der neue Aktivitätskanal wird auf dieselbe Dokumentidentität gesetzt. Reservierungen sind ein eigener optionaler Vertrag, keine Verlängerung des Aktivitätsstatus. Der reine Transport kann weitgehend wiederverwendet werden; Konsistenzregeln und Historie werden ausdrücklich neu geprüft.

### Schritt 3C: Einen vollständigen DMS-Pfad liefern

Ein priorisiertes DMS mit persönlicher Identität, Quellenrechten, stabilen Dokument-/Aktenreferenzen, Versionen, Arbeitskopien und geprüftem Zurückspeichern vollständig anbinden. Fehlende Providerfähigkeiten offen ausweisen. Native Teamreplikation und DMS-Sync dürfen dieselbe Arbeitskopie nicht konkurrierend veröffentlichen. Bestehende generische Speicheradapter bleiben als einfachere Integrationen verfügbar.

Ein streng verwalteter Cache ist ein separater späterer Ausbau mit eigener Abnahme für Schlüsselverwaltung, externe Bearbeitung, Offline-Berechtigungsdauer und Wiederherstellung. Er blockiert weder Schritt 1 noch den normalen nativen Dateisync.

### Schritt 4: Leistungserfassung und Finanzintegration

Baut auf stabilen Mandatsidentitäten und Finanzrechten auf, benötigt aber nicht den Abschluss sämtlicher Dokument-/DMS-Arbeiten. Zunächst lokale/offline Erfassung mit kontrollierter Übertragung in das führende Kanzleisystem, danach Freigaben, Budgets und Auswertungen. Leistungen halten ihren ursprünglichen Mandatsbezug auch beim späteren Umhängen eines Projekts; eine Korrektur ist ein eigener protokollierter Vorgang. Welche Abrechnungsfunktionen Legal Work selbst führt, richtet sich nach konkreten Kanzleibedarfen.

### Schritt 5: Gemeinsames Bearbeiten und Cloud-Ausführung erweitern

Co-authoring, externe Portale und autonome Cloud-Aufträge verwenden dieselben Identitäten, Schreibverträge und Rechte. Vor einem Cloud-Auftrag und vor der Annahme seiner Ergebnisse werden Berechtigung und Datenfreigabe erneut geprüft. Ein persönlicher Cloud-Assistent ist weder ein zweites Berechtigungssystem noch ein Weg um Versionsprüfungen.

**Abhängigkeiten:** Schritt 1 → Schritt 2 → Finanzfunktionen; Editorverbesserungen können parallel starten. Das neue native Versionssystem benötigt den geprüften Plattformvertrag, die vollständige DMS-Anbindung ihren eigenen Anbieter- und Rechtevertrag. Die Mandantenübersicht wartet nicht auf ein neu gebautes DMS.

## 5. Akzeptanzszenarien je Etappe

Diese Szenarien sind Vorgaben für die Umsetzung, keine bereits ausgeführten Tests. Freigaben erfolgen je Etappe; der erste Sidebar-Ausbau muss nicht sämtliche späteren DMS- und Finanzkriterien erfüllen.

| Etappe | Szenario und erwartetes Ergebnis |
|---|---|
| 1 | Zwei Projekte desselben Mandanten mit verschiedenen Teams: jedes Mitglied sieht nur zulässige Projekte, Namen und Zähler. Wechsel der Sidebar-Gruppierung verändert keine Rechte. |
| 1 | Internes, mit der Kanzlei geteiltes Projekt: Mandats-/Mandantenzuordnung bleibt leer; Teilen erzeugt keinen künstlichen Mandanten. |
| 1 | Zwei Projekte desselben Mandats und zwei Mandanten dieses Mandats: eindeutige Referenzen, keine kopierten Projekte, keine widersprüchlichen unabhängigen Mandantenfelder. |
| 1 | Projektdetails-Sync ausgeschaltet: berechtigte Empfänger erhalten die fachliche Zuordnung trotzdem. |
| 1 | Offline neuen Mandanten und neues Projekt anlegen; Übertragung mehrfach unterbrechen: ein Mandant, ein Mandat und eine Zuordnung nach erfolgreicher Annahme. Namensgleiche Datensätze werden nur bei berechtigter Sicht zur Zusammenführung vorgeschlagen. Abgelehnte Vorgänge bleiben als lokale, nicht veröffentlichte Entwürfe erkennbar. |
| 2 / 4 | Projekt in ein anderes Mandat umhängen: keine stille Teamvereinigung; bereits erfasste Leistungen behalten ihren alten Mandatsbezug. |
| 3A | 17 wiederhergestellte Arbeitsbereiche: unberührte Dokumente bleiben unreserviert. Ein sauberes inaktives Fenster erzwingt keinen Übernahmedialog. Bearbeitung im zweiten eigenen Fenster und eine Übergabe verlieren auch bei Absturz keinen bereits gesicherten Entwurf. |
| 3A | Neue Fassung trifft bei sauberer oder geänderter offener Ansicht ein: Hinweis statt stiller Ersetzung; Vergleichen und Übernehmen erhalten die eigene Arbeit. |
| 3B | Zwei Teammitglieder oder dieselbe Person auf zwei Geräten bearbeiten dieselbe Basis, eines offline: beide Fassungen bleiben erhalten; die zweite Veröffentlichung löst eine sichtbare Entscheidung aus. Eine abgelaufene Aktivitätsanzeige gilt nicht als Nachweis exklusiven Zugriffs. |
| 3A / 3B | Mensch, Agent und integrierte externe Arbeitskopie arbeiten am gleichen Dokument: Autor/Basis sind erkennbar, kein Umgehen des Commit-Vertrags, Entwürfe bleiben erhalten. Direkte unkontrollierte Dateisystemschreiber werden getrennt auf die tatsächlich zugesagte Schutzwirkung geprüft. |
| 3B | Server nimmt eine Veröffentlichung an, Bestätigung geht verloren: Wiederholung mit gleicher Operations-ID erzeugt genau eine angenommene Version. Eine Wiederherstellung früheren Inhalts erzeugt dagegen eine neue Version. |
| 3B | Kontrolliertes Umbenennen eines Dokuments oder Ordners bei paralleler Bearbeitung: Identität bleibt bestehen, keine irreführende Massenlöschung. Bei unklarer externer Zuordnung und identischen Dateikopien wird keine Identität allein aus dem Hash geraten. Löschen gegen Bearbeiten endet in einer sichtbaren Entscheidung mit erhaltener Arbeit. |
| 2 / 3B | Reservierung aufheben, Rechte entziehen oder Benutzer sperren, während ein Commit läuft: eindeutig festgelegte Reihenfolge, keine Veröffentlichung nach wirksamem Entzug. Alte Reservierungsinhaber überschreiben keinen neueren Stand. |
| 2 | Billing sieht erforderliche Kennungen und Leistungen, aber keine gesperrten Inhalte. Suche, Vorschauen, Agenten, Wiki-Ableitungen, Exporte und Benachrichtigungen umgehen diese Grenze nicht. |
| 2 / 3C | Rechteentzug mit ungesendeter Arbeit: begrenzter Übergabekanal nimmt nur eine Quarantänefassung an, gibt keine Projekt-Leserechte zurück. Eigene Ordner/Exporte werden nicht als erfolgreich zurückgerufen ausgegeben. Offline-Zusagen entsprechen der tatsächlich verwendeten Speicherart. |
| 3C | DMS-Dokument umbenennen, bearbeiten und zurückspeichern: richtige Identität, Version und persönliche Rechte; kein zweiter Upload über nativen Team-Sync. |
| 2 | Verantwortlicher Partner verlässt die Kanzlei: Akten, Projekte und Zuständigkeiten bleiben organisatorisch übernehmbar. |
| 4 | Offline erfasste Leistungen wiederholt synchronisieren: keine doppelte Verbuchung; freigegebene und abgerechnete Positionen ändern sich nur nachvollziehbar. |

## 6. Festgelegte Richtung und verbleibende Entscheidungen

Für den überarbeiteten Plan sind festgelegt: frühe Mandatsidentität mit einfacher Oberfläche; mehrere Projekte pro Mandant und pro Mandat; interne Projekte ohne künstlichen Mandanten; organisationsbezogener, zugriffsgefilterter Stamm; automatischer Sync gespeicherter nativer Projektdateien; bewusstes Zurückspeichern von DMS-Arbeitskopien; keine Sperre allein durch Öffnen; beständige geöffnete Ansicht mit Hinweis auf neue Versionen; stabile Dokumentidentitäten auch für native Dateien als eigener Ausbau.

Standard für Teamarbeit ist eine zeitlich begrenzte Aktivitätsanzeige mit bewusster paralleler Bearbeitung, ergänzt durch optionale beziehungsweise DMS-vorgegebene Reservierungen. Daraus folgt kein Verbot, später für bestimmte Dokumente eine verbindliche Reservierung zu verlangen. Diese Richtlinie wird nicht durch einen dauerhaft offenen Tab ausgelöst.

Vor den jeweils betroffenen Etappen sind noch festzulegen:

1. **Reservierungsrichtlinien:** Für welche Dokumentarten oder Kanzleien soll eine Reservierung verpflichtend sein, mit welcher Dauer und welchen Aufhebungsrechten? Der Standardablauf bleibt ohne Öffnungssperre.
2. **Erstes DMS und externe Bearbeitung:** Welche konkrete Integration und welche externen Editoren werden mit belastbarem Schreibvertrag zuerst unterstützt? Einfacher Dateizugriff bleibt von dieser Zusage getrennt.
3. **Versionen und Aufbewahrung:** Welche gespeicherten Fassungen erscheinen als benannte Arbeitsstände, wie werden automatische Stände dargestellt, und welche Wiederherstellungs-/Aufbewahrungsfristen gelten? Die interne Commit-Identität und Konfliktsicherung hängen nicht von einer manuellen Versionsbenennung ab.
4. **Sichtbare Mandatsübersicht:** Wann wird die zusätzliche Ebene eingeblendet und wie werden mehrere Mandanten dargestellt? Das zugrunde liegende Beziehungsmodell steht bereits fest.
5. **Streng verwaltete Offline-Daten:** Für welche Mandate ist ein kontrollierter Cache erforderlich, und welche externen Zugriffe sind dann zulässig? Bis zu seiner Abnahme gibt es keine pauschale Rückruf- oder Offline-Ablaufgarantie für normale Projektdateien.

Diese Entscheidungen blockieren nicht die erste Mandantenübersicht. Der konkrete Plattformvertrag und die Migration sind dagegen Voraussetzung für die jeweilige Implementierung; sie müssen anhand des tatsächlichen Backends ausgearbeitet werden.
