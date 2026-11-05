# Connected storage

Open in LegalWork: [File storage](legalwork://app/settings/extensions/storage).

## Add a connection

Open **Settings > Integrations > File storage**. Choose a provider, enter its location and credentials or complete its sign-in flow, choose read-only or write access as appropriate, and test the connection. A successful test confirms that the root can be listed; it does not prove write permission. Enabled connections appear as named roots in Memory Drive.

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

In a writable folder, upload or drop files and create folders using the available controls. Existing-name and read-only errors should be resolved rather than ignored. Pausing a connection hides/disables access without deleting its source. Disconnecting removes the connection configuration, not the remote files. Deleting a file through a file action is a separate operation.

## Edit and save back

Opening a connected file downloads a working copy into the selected workspace. Editor and agent saves update that copy. **Save…** provides **Save to [connection]** to publish back and **Save local copy…** to keep a separate workspace file. A read-only source can still be used for a local edited copy if workspace writing is allowed.

If another person changes the source, a save can report a conflict. Keep your local draft. **Open latest from [connection]** preserves the previous working copy and opens the newer source. Review and reconcile before trying again. Conflict protection differs between cloud APIs and file-server protocols, so it is not an assurance against every external write race.

## Team storage

The **Local / Team** selector, when available, separates installed connections from connections shared by your firm. Admins can share a connection and choose whether everyone receives it automatically or members add it themselves with **Add to Memory Drive**. Removing it from one workspace differs from removing the team's connection. Team features depend on sign-in, entitlements and role. Local connection credentials belong to the LegalWork installation running the connection. A separately operated LegalWork server has its own credentials.

Related: [Files](files-documents.md), [Integrations and LegalMemory](integrations.md), [Permissions](settings-privacy.md).
