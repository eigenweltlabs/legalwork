# Files and document editors

## Find and open a file

Use **Memory Drive** to browse workspace files and configured storage roots. Open a file into the side panel, or attach it to the composer so the assistant has a concrete target. File links in chat also open supported artifacts. Tabs allow documents to stay beside the conversation. Available context-menu actions depend on the file and runtime, including opening externally, revealing the file, downloading or saving a copy.

Give an exact filename or attach the document when several copies exist. "This document" should mean the document actually open beside the chat. Check that the assistant is working on that version. Save pending edits before switching to a conflicting copy or accepting a discard prompt.

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

## Word review

For a document open in LegalWork, the assistant uses the live document tools and makes tracked suggestions in that document. Review comments and changes in the editor. Ask it to accept or reject particular changes when you intend to finalize them. Existing changes from other reviewers should be distinguished from the assistant's changes.

For a document open in Microsoft Word with the add-in connected, use the live Word tools instead. For a file with neither live surface available, the bundled `docx-edit` skill can inspect and write a separate redlined copy. File-mode output names such as `.redlined.docx` identify a new deliverable, not a change to the open Word document. See [Office Add-ins](office-addins.md).

## PDF actions

Ask to annotate, fill a form, stamp a signature or read a PDF; the assistant can load `pdf-tools`. The `/annotate`, `/fill-form`, `/sign` and `/open` commands are additional entry points where available. PDF actions normally produce `.annotated.pdf`, `.filled.pdf` or `.signed.pdf` copies beside the source. A signature stamp is a visual mark, not a promise of a cryptographic signature. A scanned page without a text layer may need OCR; an empty extraction is not evidence that the page is blank.

## Saving and source files

Check the returned output path and open the saved file. Local editor saves update workspace files or working copies. A connected-storage working copy requires **Save to [connection]** to publish changes back; automatic local saving does not publish it. See [Connected storage](connected-storage.md). Files created for a task can also be attached back to that task so they are discoverable from the work list.
