# Files and document editors

## Find and open a file

Use **Memory Drive** to browse workspace files and configured storage roots. Open a file into the side panel, or attach it to the composer so the assistant has a concrete target. File links in chat also open supported artifacts. Tabs allow documents to stay beside the conversation. Available context-menu actions depend on the file and runtime, including opening externally, revealing the file, downloading or saving a copy.

Give an exact filename or attach the document when several copies exist. "This document" should mean the document actually open beside the chat. Check that the assistant is working on that version. Save pending edits before switching to a conflicting copy or accepting a discard prompt.

File cards in chat show the filename without its folder path. Select a card to open the referenced file.

When you send a message with a document from Memory Drive, the composer clears immediately. The outgoing message shows **Preparing attachments…** while LegalWork saves the document for the chat. If preparation or submission fails, your message and its attachments return to the composer so you can retry. Anything you typed meanwhile is kept separately and returns after you send or clear the restored draft.

## Supported work

| File type | What to use |
| --- | --- |
| Markdown and text | Read or edit in the text/Markdown panel; saved workspace files remain ordinary files. |
| Word `.docx` | Use the in-app editor for text, tracked changes and comments; ask the assistant to read, redline, comment, or accept/reject selected changes. |
| Excel `.xlsx` | Open the workbook in the spreadsheet editor; inspect the relevant sheet/range and verify saved changes. |
| PowerPoint `.pptx` | Open the presentation in the slide editor; inspect slides and verify the output after edits. |
| PDF | View pages; use the bundled PDF skill for text extraction, annotations, form fields and signature stamps. |
| HTML | Open the browser preview for generated reports, interactive review tables and other HTML artifacts. |
| Images, audio and video | Use the supported preview/player; unsupported formats may need an external app. |

Office-format rendering is editor-dependent. Complex Word layouts, spreadsheets and presentations should be checked in the target Office application when fidelity matters. Supporting a file extension is not a guarantee that every feature of that format is editable.

Document requests for the same file run in order. **Stop** cancels requests that are still waiting; already applied changes may finish saving and remain available for review. A timed-out document request does not mean the document is closed.

## Word review

For a document open in LegalWork, the assistant uses the live document tools and makes tracked suggestions in that document. Review comments and changes in the editor. Ask it to accept or reject particular changes when you intend to finalize them. Existing changes from other reviewers should be distinguished from the assistant's changes.

Bilingual Word tables retain their text columns, including rows with unused space at the end. You can review both language columns together in the in-app editor.

For a letterhead or unfamiliar template, ask the assistant to inspect the writing areas first. It can distinguish the main text from table cells, positioned text boxes, headers, footers and footnotes, and read the page geometry and reserved wrapping areas without generating images. It can request a page image when a visual question needs one. These inspection images stay out of the chat and do not change your view. Ask it to add a letter to the main text or to fill a specific template field. New letters use separate Word paragraphs for the date, salutation, body and closing. Text placed inside an existing table or text box requires that area to be selected explicitly by the assistant.

While the assistant writes in the background, a small live document tile appears in the chat. Longer drafts appear in sections as edits are applied. Use the tile's arrow to open the same editor beside the chat, or its close button to hide the tile. If you switch to another document tab while the task continues, the working document returns to its tile. The tile uses the live editor without generating page images or consuming image tokens. It disappears when the task finishes; use the resulting file link to open the saved document.

Page-sized letterhead artwork keeps its position and transparent areas when you open or save the document. Body text appears in front of pictures that the template places behind the text and wraps around reserved header or footer objects, including transparent ones. New text inherits the template’s fonts and paragraph formatting. Addresses with manual line breaks use left alignment unless another alignment is explicitly requested.

Word dims inactive headers and footers while you edit the body; LegalWork shows their print colors. This does not change the saved artwork. If Word shows nearly white body text on a white page-sized letterhead image, use **View > Switch Modes** to select a light page. Word’s dark page mode changes text colors but leaves that image white. This viewing mode does not change the document’s print colors.

For a document open in Microsoft Word with the add-in connected, use the live Word tools instead. For a file with neither live surface available, the bundled `docx-edit` skill can inspect and write a separate redlined copy. File-mode output names such as `.redlined.docx` identify a new deliverable, not a change to the open Word document. See [Office Add-ins](office-addins.md).

## PDF actions

Ask to annotate, fill a form, stamp a signature or read a PDF; the assistant can load `pdf-tools`. The `/annotate`, `/fill-form`, `/sign` and `/open` commands are additional entry points where available. PDF actions normally produce `.annotated.pdf`, `.filled.pdf` or `.signed.pdf` copies beside the source. A signature stamp is a visual mark, not a promise of a cryptographic signature. A scanned page without a text layer may need OCR; an empty extraction is not evidence that the page is blank.

## Saving and source files

Check the returned output path and open the saved file. Local editor saves update workspace files or working copies. A connected-storage working copy requires **Save to [connection]** to publish changes back; automatic local saving does not publish it. See [Connected storage](connected-storage.md). Files created for a task can also be attached back to that task so they are discoverable from the work list.

Markdown files can include saved report and dashboard blocks. The chart renders within the document, and its **Open in tab** control opens a larger view. Assistant document cards open the file only when selected. See [Dashboards and reports](dashboards.md).
