# Optional Akte metadata

The starter template is an adaptable matter schema. It is not a mandatory legal standard. Every value starts empty; projects can be created without filling any field, and all fields can be removed.

| German | English | Type |
| --- | --- | --- |
| Aktenzeichen | Matter reference | Text |
| Mandant | Client | Text |
| Gegenpartei | Opposing party | Text |
| Gegenstand | Matter subject | Text |
| Rechtsgebiet | Practice area | Text |
| Verantwortlich | Responsible lawyer | Text |
| Sachstand | Status | Selection: Open, In progress, Waiting, Closed |
| Mandatsbeginn | Opened on | Date |
| Gericht / Behörde | Court / authority | Text |
| Fremdaktenzeichen | External reference | Text |

Text fields permit firms' existing conventions without imposing a reference-number format, staff directory or practice-area taxonomy. Project name already supplies the short title. The template avoids billing, conflict-check and deadline-management claims. Deadlines belong in dedicated task/calendar workflows.

## Research basis

[RA-MICRO Aktenregister](https://helpdesk.ra-micro.de/help/de-de/170-aktenregister/833-allgemein) and [Rechtsanwaltsakte anlegen](https://helpdesk.ra-micro.de/help/de-de/474-x/2033-x) describe matter identifiers/descriptions, participants, responsibility, practice area and case status. [DATEV Anwalt classic](https://www.datev.de/web/de/rechtsberatung/loesungen/mandatsbearbeitung/akte-verwalten/datev-anwalt-classic) treats tasks, reminders and deadlines as distinct workflows. The proposed template adapts these patterns; court/authority and external reference are pragmatic optional additions, not a claim that these vendors mandate this exact schema. Reviewed 24 September 2026.

## Behavior

- Settings → Customization → Projects configures the template. Suggested field labels use stable IDs with an English/German mapping, including recognized legacy defaults. Editing a label marks it as custom; custom labels remain exactly as entered, even when saved to defaults. Values and selection choices are preserved when switching language.
- Each project owns its schema and values. New projects receive the current defaults at creation. Older projects without saved metadata show the current defaults with empty values in the home view and field editor; the first metadata save stores the schema with the project. Saved schemas and values are preserved, including deliberately removed fields and an explicitly empty default schema.
- Project values edit inline: Enter or leaving the input saves; Escape cancels. Selection fields save when selected. Dates and numbers display in the app language.
- The field-settings icon opens schema editing. A custom field not already in the template has **Save to defaults** on its row. This appends its definition and choices with a null value, avoiding duplicate IDs. It does not copy client data into future projects.
- Defaults currently persist per app/device. Per-project schemas and values remain in the existing versioned `.legalwork/project.json` sidecar; documents stay in their selected/default project folder. Cross-device synchronization remains EIG-208.
