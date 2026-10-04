# Demo: a deadline you can inspect and teach

Use the **LegalWork - Dev** Electron app with the default dev profile and the project **Deadline learning demo**. The two searchable PDFs are already in that project's files and in `output/pdf/`. They are clearly labelled fictional. Dates deliberately match DeadlineBench v0.8.0, so the calendar entry is in **January 2026**, not today.

## Recording sequence (about 90 seconds, with waiting cut out)

1. Start a new chat. Drop **01-ordinary-response.pdf** into it. Send:

   > Bitte merke die beauftragte Antwortfrist im Kalender vor. Zeige mir zuerst die Berechnung und die Belegstelle im PDF, damit ich sie prüfen und speichern kann.

   Expected: ordinary two-week response period, **26 January 2026**. The card shows the requested deadline, inputs, the actual executed steps and the result. Click the PDF chip to highlight the service date. Click **Save to calendar**. Do not describe this ordinary response period as a Notfrist or the absolute last objection date.

2. Drop **02-absolute-objection-cutoff.pdf**. Send:

   > Bitte prüfe den Auftrag in dieser zweiten Datei. Bestimme den letzten überhaupt noch zulässigen Tag für den Widerspruch und zeige mir vor dem Speichern wieder die Berechnungskarte.

   This is the benchmark's difficult case. If the model incorrectly offers 26 January as the absolute cutoff, click **Correct** and replace the prefilled text with:

   > Hier ist nicht die gewöhnliche Zweiwochenfrist gefragt. Nach § 694 Abs. 1 ZPO ist Widerspruch möglich, solange der Vollstreckungsbescheid noch nicht verfügt ist. Die spätere Verfahrensakte fehlt. Daher: needs_information und kein Fristdatum. Die zwei Wochen sind keine Notfrist. Bitte speichere diese Unterscheidung als wiederverwendbare Ergänzung zu de-civil-deadlines in meiner Skill-Bibliothek. Die normale Zweiwochen-Wiedervorlage darf weiter berechnet werden. Nimm beide Fälle als Beispiele auf.

   Expected: the agent saves a new **skill**, extending `de-civil-deadlines`, with the correction, its scope, a positive example and the ordinary-period counterexample. The base remains intact. Ask for the exact saved name if it is not shown. It is available in Settings > Skills.

3. **Start a new chat in the project**, so the result cannot depend only on the correction being in chat history. Drop the second PDF again and send:

   > Bitte bestimme die im Auftrag gesuchte äußerste Widerspruchsgrenze. Lade dazu den deutschen Fristen-Skill einschließlich meiner gespeicherten Ergänzungen und zeige mir das Ergebnis als Karte.

   Expected: **Information needed**, with no deadline. It asks whether and when the Vollstreckungsbescheid was ordered. This is the successful corrected result. There is deliberately no “Save deadline” action for an unknown date.

4. To end the video with a correct calendar save, say:

   > Verstanden. Bitte lege stattdessen ausdrücklich nur die gewöhnliche Zweiwochen-Antwortfrist ab Zustellung am 12.01.2026 als Wiedervorlage an. Keine Aussage zur äußersten Widerspruchsgrenze. Zeige mir die Karte zur Freigabe.

   Expected: **26 January 2026**, clearly labelled ordinary response/diary entry. Save the card. Use a fresh demo project for the final recording if you do not want this to duplicate the first illustrative diary entry.

Suggested closing line: “I can inspect the calculation, correct the legal reasoning, and keep that correction for the next matter.” This is persistent skill guidance, not model-weight training or a guarantee that every future answer is correct.

## If the model gets the second case right immediately

Do not force a live error or portray a replay as a new model failure. The stronger current model or the added selection guidance may already handle it.

`benchmark-failure.json` is an extract of the actual local DeepSeek V4.1 Flash skills-off result, including its run ID and source report. You can show this as a clearly labelled **benchmark replay**, then record the correction and fresh-chat rerun live. Prompt:

> Die Datei benchmark-failure.json enthält einen aufgezeichneten Fehler aus DeadlineBench. Stelle den damaligen Zweiwochen-Rechenweg als ausdrücklich gekennzeichneten „Benchmark replay: falsche Fristauswahl“ in einer Berechnungskarte dar. Rechne dafür nur die damalige gewöhnliche Zweiwochenfrist mit dem Skill nach. Erkläre sichtbar, dass ihre Verwendung als absolute Widerspruchsgrenze falsch war. Nichts speichern.

Then give the correction above. Label that shot “Recorded benchmark failure” in the video. Never claim this produced a fresh DeepSeek failure. The demo's PDF packet is a formatted synthetic version of the benchmark evidence; it is not a byte-identical benchmark evaluation.

## Reliable technical trigger

The card is deliberately opt-in. If a community skill does not call it, ask:

> Verwende legalwork_skill_load, dann den passenden Skill-Rechner und anschließend legalwork_calculation_present mit mode=confirm. Verwende die echte calculationId bzw. runId und path/page/quote für die PDF-Belege. Wenn Angaben fehlen, nutze assessment mit needs_information und ohne Datum.

No date arithmetic or substitute formula belongs in the presentation call. The server loads the stored execution. A missing-information assessment is visibly labelled agent assessment, rather than executed code. If a quote repeats, use a longer exact excerpt. If a scanned page lacks OCR evidence, prepare OCR first; never invent highlight coordinates.

## Legal and benchmark references

- [§ 694(1) ZPO](https://www.gesetze-im-internet.de/zpo/__694.html): the absolute cutoff depends on whether the Vollstreckungsbescheid has been ordered.
- DeadlineBench v0.8.0: `germany/missing-facts--docket-payment-order-longstop`. Its supplied evidence is synthetic and its metadata says independent legal review is pending.
- The demo should preserve the distinction between a correctly computed period and a correctly selected legal deadline.
