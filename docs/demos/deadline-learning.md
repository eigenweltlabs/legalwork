# Demo using the original DeadlineBench files

Use **LegalWork - Dev**, the default dev profile, and the project **DeadlineBench · LG Köln**. The project contains the original packet for `germany/service-evidence--docket-koeln-served-a`. Its `Mahnbescheid/` folder contains the original inputs for `germany/missing-facts--docket-payment-order-longstop`.

The same files are checked in under `docs/demos/deadlinebench/`. Every file is copied byte-for-byte from DeadlineBench v0.8.0. `provenance.json` records its task, repository path and SHA-256. No new PDFs or source facts were invented for this demo. Do not put task.json, criteria or gold answers into the agent's project.

The Cologne PDF is the actual published Landgericht Köln order, 33 O 219/24, dated 10 July 2024. DeadlineBench extracted its two scanned order pages from the recipient's public PDF. The benchmark's accompanying service record is explicitly fictional. The Mahnbescheid case consists of two explicitly fictional benchmark text files, not an original court PDF. Keep these distinctions in the video.

## Recording sequence

1. Start a new chat. Attach `gerichtliche-verfuegung.pdf` and `Zustellungsnachweis.txt` from the Cologne packet, or use the files already in the project. Send:

   > Calculate the statement-of-defence deadline from gerichtliche-verfuegung.pdf and Zustellungsnachweis.txt. Let me check before saving.

   Expected: **14 August 2024**, the benchmark's expected date for the defence. The original order says two further weeks after the first two-week period, altogether four weeks from service. The benchmark service record gives 17 July 2024. The card shows the start, counted period, endpoint check and final date. Click the single PDF source button to inspect its highlighted passages, then **Save to calendar**. A separate button opens the service record. The saved entry is historical and appears in August 2024.

2. Attach `Mahnbescheid/Mahnbescheid.txt` and `Mahnbescheid/Mandatsnotiz.txt`. Send:

   > What is the final cutoff for objecting, based on these two files?

   This is the original failing benchmark case. If the model incorrectly offers 26 January 2026 as the absolute cutoff, click **Change** and send:

   > Hier ist nicht die gewöhnliche Zweiwochenfrist gefragt. Nach § 694 Abs. 1 ZPO ist Widerspruch möglich, solange der Vollstreckungsbescheid noch nicht verfügt ist. Die spätere Verfahrensakte fehlt. Daher fehlen Angaben und es gibt kein bestimmbares Fristdatum. Die zwei Wochen sind keine Notfrist. Bitte speichere diese Unterscheidung als wiederverwendbare Ergänzung zu de-civil-deadlines in meiner Skill-Bibliothek. Die normale Zweiwochen-Wiedervorlage darf weiter berechnet werden. Nimm beide Fälle als Beispiele auf.

   Expected: the agent saves a discoverable skill in Workflows extending `de-civil-deadlines`, retaining the scope, correction and two examples. The base skill remains intact. The global extension is available in Workflows and automatically included whenever the agent loads the base skill.

3. Start a **new chat**. Attach those same two Mahnbescheid text files and send:

   > What is the final cutoff for objecting, based on these two files?

   Expected: **Information needed**, with no date. It asks whether and when the Vollstreckungsbescheid was ordered. This is the correct result for the case, not a failed calculation. There is no calendar-save action for an unknown date.

4. To finish the video with a valid save, ask:

   > Prepare only the ordinary two-week response deadline from service on 12 January 2026. Let me check before saving.

   Expected: **26 January 2026**, clearly labelled ordinary response or diary entry. Save the card.

Suggested closing line: “I can inspect the calculation, correct the legal reasoning, and keep that correction for the next matter.” This saves reusable skill guidance. It does not train model weights or guarantee every future answer.

## If the model already gets the second case right

The live model handled this case correctly during the earlier validation. Do not force a live error or portray a replay as a new model failure.

`benchmark-failure.json` records the actual local DeepSeek V4.1 Flash skills-off result, with run ID and source report. For a reliable correction scene, attach it and use a clearly labelled **benchmark replay**:

> Diese Datei enthält einen aufgezeichneten Fehler aus DeadlineBench. Stelle den damaligen Zweiwochen-Rechenweg als ausdrücklich gekennzeichneten „Benchmark replay: falsche Fristauswahl“ in einer Berechnungskarte dar. Rechne dafür nur die damalige gewöhnliche Zweiwochenfrist mit dem Skill nach. Erkläre sichtbar, dass ihre Verwendung als absolute Widerspruchsgrenze falsch war. Nichts speichern.

Then give the correction from step 2 and rerun in a fresh chat. Label the replay in the video.

## Ordinary prompts, automatic skill guidance

Users describe the legal task, not the tools or interface. The shipped jurisdiction skills instruct the agent to present the calculation card. Asking to check before saving requests review; a plain calculation request shows the evidence directly. Community skills can choose whether to use the card.

The skill loader supplies the current tool instructions and calculator input schema alongside installed instructions, including for older skill versions. Agents should never search application folders or probe bundled code to discover how to calculate or present a result. A test fails if that detour occurs, even if the final date is correct.

The presentation call accepts receipt IDs, not replacement arithmetic. Scanned PDFs are prepared automatically using the configured OCR. Each document appears once in the card, with navigation between its passages in the viewer. TXT and Markdown evidence uses an exact quote without a page number. Raw code, dependency bundles, hashes and intermediate machine timestamps stay out of the card.

## References and validation

- [§ 694(1) ZPO](https://www.gesetze-im-internet.de/zpo/__694.html).
- [Published Cologne source PDF](https://www.ufkb.de/content/download/1611/file/Landgericht.pdf). See the original benchmark `provenance.txt` for the extract's provenance.
- DeadlineBench v0.8.0, tasks `germany/service-evidence--docket-koeln-served-a` and `germany/missing-facts--docket-payment-order-longstop`. Independent legal review is marked pending in its metadata.
- The test distinguishes correct period arithmetic from correct legal deadline selection.
