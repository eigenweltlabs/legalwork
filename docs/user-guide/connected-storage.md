# Connected storage

Open in LegalWork: [File storage](legalwork://app/settings/extensions/storage).

## Add a connection

Open **Settings > Integrations > Files & storage**. Select a provider and choose **Connect**, enter its location and credentials or complete its sign-in flow, choose read-only or write access as appropriate, and test the connection. A successful test confirms that the root can be listed; it does not prove write permission. Enabled connections appear as named roots in Memory Drive and under **Installed** in Integrations. Select an installed connection and choose **Manage** to edit it, or **Add another connection** to create a separate named source.

Account-based storage uses your own sign-in on this device. File-server and bucket connections use the configured server credentials. The current app supports account connections offered in the provider picker as well as SMB, WebDAV, S3-compatible storage, Azure Blob Storage, Google Cloud Storage, SFTP and FTP/FTPS. Available providers and authentication methods can depend on the account and runtime.

| Provider | Information to prepare |
| --- | --- |
| SMB network share | Host, share name, optional folder prefix and Windows domain, username/password. For `\\OFFICE-PC\RA-MICRO\Documents`, use host `OFFICE-PC`, share `RA-MICRO`, prefix `Documents`. |
| WebDAV | Server endpoint and the account or headers required by that server. |
| S3-compatible | Existing bucket, region, optional endpoint/prefix, and credentials or server credentials. |
| Azure Blob | Existing account/container and account key or SAS access. |
| Google Cloud Storage | Existing bucket, optional project/prefix, service-account credentials or server credentials. |
| SFTP | SSH host, port, account, root path, verified SHA256 host fingerprint, and password or private key. |
| FTP/FTPS | Host, account, root path and the supported TLS mode. |

SMB accesses the share directly without mounting it. Access to RA-MICRO folders provides files, not automatic access to its databases or E-Akte registration. Provider permissions continue to apply.

## Browse, search and upload

Expand a root or folder to fetch its contents. Load additional pages when available. Search behavior is provider-dependent: filename searches and native provider search are different from full-text indexing. The returned search scope matters, especially for network shares. These connections do not automatically index their files in LegalMemory.

Files in a whole-account Google Drive connection can still open after their folders move or are renamed. LegalWork checks the file's version before and after downloading it. If the file changes or a shortcut points to a different file while it opens, refresh and open it again. Folder views and linked project folders also check that the file and its parents remain inside the selected location.

In a writable folder, upload or drop files and create folders using the available controls. Existing-name and read-only errors should be resolved rather than ignored. Pausing a connection hides/disables access without deleting its source. Disconnecting removes the connection configuration, not the remote files. Deleting a file through a file action is a separate operation.

Google Drive files and folders can be renamed in My Drive and shared drives when your account has permission. A rename keeps the same file or folder and its contents; it does not create a copy. LegalWork checks for intervening changes and refuses an existing destination. If a conflict is reported, refresh the parent folder and review its current contents before trying again.

To delete an item, open its menu in Memory Drive, choose **Delete file** or **Delete folder**, and confirm. Deleting a Google Drive item moves it to Google Drive's trash; a folder deletion includes its contents. Local working copies are kept. If the item changes while deletion is being checked, LegalWork stops and reports a conflict. Refresh and review the item before trying again.

Cloud file locations in search results, tooltips, and rename or delete dialogs show readable folder names. Before confirming a deletion, check both the connection name and the folder path. LegalWork keeps the provider's file identity internally so duplicate names still refer to the exact item you selected.

## Move and copy files

In a project chat, ask LegalWork to move or copy a file or folder, naming its source connection and destination folder. For example: “Move Contract.docx from My Drive/Matters into My Drive/Archive.” The destination folder must already exist and allow writing. Moving also requires permission to change the source; copying keeps the original and can use a read-only source. An existing item with the same name prevents the transfer.

Chat transfers use the connections available in the current project and keep the chat's access level. A chat with read-only access cannot move files or create copies, even when the storage connection itself allows writing.

Dragging a file or folder between folders in Memory Drive copies it. Within the same Google Drive, OneDrive or SharePoint connection, files are copied inside the provider without downloading and uploading their contents through LegalWork. Google Docs, Sheets and Slides stay in their native format when copied this way. Originals are kept. Copies between different connections or through other providers can still require downloading and uploading.

To move an item, ask in chat. Google Docs, Sheets and Slides copied to another connection become exported files; moving those native documents across connections is unavailable. If a transfer reports that it did not finish, refresh and inspect both folders before retrying: some copies may already exist or still be processing, and removal of originals during a move may be incomplete.

## Edit and save back

Opening a connected file downloads a working copy into the selected workspace. Google Drive, OneDrive and SharePoint working copies and new chat attachments use readable filenames without the provider's internal file ID. Files with the same name are kept in separate working-copy folders. Attachments already saved in a chat keep their existing names; attach the source again to use its readable name. Editor and agent saves update the working copy. **Save…** provides **Save to [connection]** to publish back and **Save local copy…** to keep a separate workspace file. A read-only source can still be used for a local edited copy if workspace writing is allowed.

If another person changes the source, a save can report a conflict. Keep your local draft. **Open latest from [connection]** preserves the previous working copy and opens the newer source. Review and reconcile before trying again. Conflict protection differs between cloud APIs and file-server protocols, so it is not an assurance against every external write race.

## Access changes

LegalWork checks local account and permission changes before further requests. Firm access is checked automatically while browsing, normally within about 30 seconds, and again when an operation starts writing. If an access check fails, LegalWork stops further requests. Requests already sent may finish. Reconnect only when LegalWork asks you to; a temporary connection-service outage can be resolved by trying again later.

## Team storage

Connections shared by your firm appear alongside your other connections and are marked **Firm managed** on their detail page. Personal connections are marked **My own**. The detail page shows status, ownership and access together, with **File Storage Integration** identifying the connection type. Admins can share a connection and choose whether everyone receives it automatically or members add it themselves with **Add to Memory Drive**. Removing it from one workspace differs from removing the team's connection. Team features depend on sign-in, entitlements and role. Local connection credentials belong to the LegalWork installation running the connection. A separately operated LegalWork server has its own credentials.

Related: [Files](files-documents.md), [Integrations and LegalMemory](integrations.md), [Permissions](settings-privacy.md).
