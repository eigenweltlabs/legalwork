# Office Add-ins

Open in LegalWork: [Office Add-ins](legalwork://app/settings/office-addins).

LegalWork can run its assistant in a sidebar inside Microsoft Word, Excel and PowerPoint. Installation is supported from the desktop app on macOS and Windows. The Office application must be installed, and LegalWork must remain running while the add-in is in use.

## Install

1. Open **Settings > Office Add-ins** in LegalWork.
2. Choose **Install** for the Office application you want. The app detects installed Office applications and shows each one's status.
3. Approve the operating system's certificate-trust prompt. This sets up a secure localhost connection between Office and LegalWork. Do not provide your OS password in chat.
4. Fully quit and reopen the Office application. On macOS, use Command+Q rather than just closing the document window.
5. In Office, open LegalWork under **Home > Add-ins** and keep its sidebar open with the target document.

One local certificate and add-in server serve the installed Office apps. Uninstalling one app's add-in does not remove another's; removing the last add-in also removes the shared local connection components. This is a locally installed add-in, not a promise that a public Office marketplace listing is required.

## Work on the live document

In Word, ask the assistant to read the current document or selection, find text, add comments or propose tracked changes. Check the live Word document and use Word's review controls to accept/reject suggestions. In Excel, the live tools can inspect sheets/ranges and make supported workbook changes. In PowerPoint, they can inspect the deck and perform supported slide operations. Available tools depend on a live document connection and the Office host's APIs.

A live Office edit changes the document open in that Office app. The in-app LegalWork editor is a separate surface. If you mean a workspace file instead, name it explicitly. A file-based redlined copy is also a different output from a change inside the currently open Word document.

## Troubleshoot the connection

Check that LegalWork is open, the relevant add-in is installed, the local certificate is trusted, and the add-in server is running according to the settings status. Fully restart Office after setup changes. If no Office app is detected, install a supported Office application first. A browser-only LegalWork session cannot install native Office add-ins.

The localhost connection runs locally, but the assistant still sends model requests to the selected provider. Do not interpret local add-in transport as a guarantee that a hosted model never receives document content needed for the task.

Related: [Document editors](files-documents.md), [Models](models-fusion.md), [Troubleshooting](troubleshooting.md).
