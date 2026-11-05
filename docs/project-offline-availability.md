# Project state offline availability

LegalWork requests persistent local availability for existing `.opencode` and `.legalwork` directories. It does not move projects, exclude files from synchronization, pin the surrounding documents, or follow linked helper folders/files. The existing reload watcher is retained.

The request runs before embedded startup configuration imports, before server reload watchers start, when workspace initialization creates `.opencode`, and when project metadata writes create `.legalwork`. Requests share in-flight work per directory. Unsuccessful requests are retried after one minute on later project access; acknowledged pins are not rewritten during routine metadata refreshes. Requests run again after app restart or directory replacement. Read-only server startup and metadata reads do not apply pins. Downloads remain asynchronous: a successful pin request is not a report that every file has finished downloading.

## Native mechanisms

- **Windows:** detect a Cloud Files sync root with `CfGetSyncRootInfoByPath`, then set `CF_PIN_STATE_PINNED` with `CfSetPinState`. Enumerate entries without following links and open each entry with `FILE_FLAG_OPEN_REPARSE_POINT`; do not use recursive native traversal across arbitrary links. Directories supply inheritance for future children. Paths travel as UTF-8 JSON on stdin to fixed PowerShell/C# source, never shell interpolation. [Microsoft API](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfsetpinstate), [pin state and asynchronous hydration](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ne-cfapi-cf_pin_state).
- **macOS:** identify a File Provider item with `fileproviderctl evaluate`, set Finder's `com.apple.fileprovider.pinned#PX` attribute to `1` on the state folder and existing nested directories, and verify the provider reports `isKeepDownloaded = 1`. Existing and future files inherit their containing folder's policy; the provider manages their downloads. Enumerate directories without following links, but do not write attributes individually onto cloud-only helper files: that can hydrate them during the pin request and time out large batches even after the folder is pinned. This attribute/diagnostic interface is an undocumented compatibility mechanism, not a public Apple pinning API. Unknown output, rejected requests and provider failures do not become successful availability claims. [Finder feature](https://support.apple.com/guide/mac-help/mchl1a02d711/mac), [independent implementation of the same attribute](https://github.com/icanhasjonas/icloud-tools).

Failures are logged once per directory until a successful request. They do not prevent project access or reset project settings. Unsupported clients retain their own offline controls; there is no polling, database modification, automated Finder clicking, or automatic fallback that downloads whole documents.

## Provider coverage

Support is selected by the native storage implementation, not just the provider name. This avoids assuming that all installations of a branded client have the same capabilities.

| Provider | Mac | Windows |
| --- | --- | --- |
| iCloud Drive | File Provider pin request; live synthetic-folder test passed | Cloud Files path where exposed by the installed client; account hydration not tested here |
| OneDrive / synced SharePoint | File Provider pin request on modern clients; account test still required | Documented Cloud Files pin request; account hydration test still required |
| Dropbox | File Provider installations are eligible; legacy clients require their own offline action | Updated Cloud Files installations are eligible; legacy clients require their own offline action |
| Google Drive | File Provider streaming installations are eligible; older streaming mounts require **Offline access > Available offline** | Custom streaming mounts without Cloud Files require the client's offline action; mirrored files are already local |
| Nextcloud / ownCloud | File Provider installations are eligible, subject to client acknowledgement | Cloud Files/VFS installations are eligible, subject to the installed client's support |
| Box and other clients | Eligible when they expose the same File Provider state; otherwise manual offline controls | Eligible when they register a Cloud Files sync root; otherwise manual offline controls |

Sources: [OneDrive Mac offline behavior](https://support.microsoft.com/en-us/onedrive/save-disk-space-with-onedrive-files-on-demand-for-mac), [Dropbox Mac File Provider](https://help.dropbox.com/installs/macos-support-for-expected-changes), [Dropbox Windows Cloud Files migration](https://help.dropbox.com/installs/dropbox-for-windows), [Google Drive File Provider and offline modes](https://support.google.com/drive/answer/16631477?hl=en), [iCloud Windows offline folders](https://support.apple.com/en-ie/guide/icloud-windows/icw8531ad6b7/icloud).

The live iCloud test verified both folders, a nested skill definition, inheritance by a subsequently created file, and an unpinned adjacent document. The local Nextcloud 33.0.7 account did **not** acknowledge the request: new synthetic items remained uploading without provider item identifiers. This is an unvalidated compatibility case, not a passing Nextcloud test. OneDrive, Dropbox, Google Drive, Box and ownCloud accounts were not exercised locally.

## Verification

`bun test apps/server/src/project-availability.test.ts` tests ordinary folders, missing projects, linked folders and, on Windows, real C# compilation and Cloud Files interop against a non-cloud path containing quotes, Unicode and shell-like characters. The focused CI workflow runs this on Windows, Mac and Linux without cloud credentials.

Set `LEGALWORK_CLOUD_PIN_TEST_ROOT` to an existing, writable cloud folder to run the real-account test. It creates and removes only a new synthetic child. It never evicts existing files or changes existing documents. A configured cloud account is required; the default skip is not evidence of live-provider compatibility.
