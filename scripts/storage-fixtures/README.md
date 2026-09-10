# File storage reference fixtures

Run from the repository root. All credentials below are disposable test accounts;
all listeners bind to loopback. The fixtures do not use your configured LegalWork
workspace, credentials, or cloud accounts.

## Start services

Requirements: pnpm, Bun 1.4.2+, uv, Docker Compose, and `opencode` on PATH for the dev app.

```sh
pnpm install
docker compose -f scripts/storage-fixtures/compose.yml up -d
uv run scripts/storage-fixtures/file-servers.py
```

Keep the Python process running. It serves WebDAV, FTP, FTPS, and SFTP, generates
a temporary FTPS CA and SSH host key, and seeds files under
`/tmp/legalwork-storage-fixtures/files`. Wait for its `ready` message and for the
cloud services to start. Restarting it changes its host fingerprint and test CA.
`LEGALWORK_STORAGE_FIXTURES` can override the fixture directory for both scripts
and tests.

| Service | Endpoint | Test authentication |
| --- | --- | --- |
| MinIO (S3) | `http://127.0.0.1:19290` | `legalwork` / `fixture-password`, path-style, `us-east-1` |
| Azurite | `http://127.0.0.1:19000/legalwork` | Account `legalwork`, key in `compose.yml` |
| fake-gcs-server | `http://127.0.0.1:19444` | No credentials; project `legalwork-test` |
| WebDAV | `http://127.0.0.1:19280` | `legalwork` / `fixture-password` |
| SFTP | `127.0.0.1:19222` | Same login; fingerprint in `sftp-fingerprint.txt` |
| FTP | `127.0.0.1:19221` | Same login; plain FTP |
| FTPS | `127.0.0.1:19243` | Same login; explicit TLS, trust `ftps-cert.pem` |

The same service versions can run natively if Docker is unavailable. This is how
the implementation was verified on macOS: MinIO's official Darwin arm64 binary,
`pnpm dlx azurite@3.35.0`, and fake-gcs-server's official v1.56.1 Darwin arm64
release. Match the ports/accounts above; use fake-gcs-server's **memory** backend
and the external URL above. Older emulators have pagination and CRC metadata
differences. The Compose configuration is provided for convenience; the native
services were used for the actual integration run.

## Where the demo files live

The macOS verification used native processes on the same Mac as the dev app.
Their data lives beneath `/tmp/legalwork-storage-fixtures`:

| Demo connection | Backing data in the native setup |
| --- | --- |
| Test · S3 (MinIO) | `minio/` contains MinIO's object data; browse it through S3 or the MinIO console at `http://127.0.0.1:19291`. |
| Test · Azure (Azurite) | `azure/` contains Azurite's blob data and metadata. |
| Test · Google Cloud (emulator) | In the emulator process's memory; lost when that process stops. |
| Test · WebDAV, Test · SFTP, Test · FTPS | All three expose the same `files/Demo/` directory through their respective protocols. |

Cloud connections use a bucket/container named `legalwork-demo-<timestamp>`
and the `lawfirm/` prefix. The active name is visible when editing each
connection in Settings. The September 10 review workspace uses
`legalwork-demo-1788983252586`. Protocol tests create additional uniquely named
buckets/containers and directories, separate from the demo roots.

When using the optional Compose setup, MinIO and Azurite instead store data in
`/data` inside their containers; no host data volume is configured. GCS still
uses memory. The Python file protocols use `files/` on the host in both setups.

The earlier `Firm files` connection has been removed. Its former backing
folder, `demo-documents/`, is no longer connected to Memory Drive. Removing a
connection never deletes its source files.

## Run reference-service tests

```sh
LEGALWORK_STORAGE_INTEGRATION=1 \
NODE_EXTRA_CA_CERTS=/tmp/legalwork-storage-fixtures/ftps-cert.pem \
pnpm --filter legalwork-server exec bun test src/file-storage.e2e.test.ts
```

The tests create unique buckets/containers and folders. They exercise real HTTP
routes and providers: authentication, workspace isolation, secret redaction,
path confinement, permissions, upload, read, edits, stale versions, concurrent
saves, file limits, folder creation, Unicode names, lazy depth-one listing,
pagination, SSH fingerprint rejection, and trusted FTPS. Without the environment
flag, only self-contained API tests run in the normal suite. These include
controlled HTTP fixtures for weak ETags and oversized-file metadata, plus a
regression check that obsolete local-folder connections cannot be used. The
dev app connections below use the running services, without mocked folder data.
Azure and GCS use emulators; live cloud accounts and IAM policies have not been tested.

## Try the dev app

In a second terminal:

```sh
# Optionally set LEGALWORK_OPENCODE_BIN to an existing OpenCode binary.
bash scripts/storage-fixtures/dev-server.sh
```

In a third terminal:

```sh
VITE_LEGALWORK_URL=http://127.0.0.1:19287 \
VITE_LEGALWORK_TOKEN=storage-dev-client \
VITE_LEGALWORK_HOST_TOKEN=storage-dev-owner \
PORT=15273 pnpm dev:ui
```

Then seed example connections and documents:

```sh
pnpm --filter legalwork-server exec bun scripts/storage-demo.ts
```

Open the settings URL printed by the seed script at `http://localhost:15273`.
Six connections are seeded: **Test · S3 (MinIO)**, **Test · Azure (Azurite)**,
**Test · Google Cloud (emulator)**, **Test · WebDAV**, **Test · SFTP**, and
**Test · FTPS**. FTPS is read-only to demonstrate the disabled write controls.
Local folders are not available as a storage provider.

1. Edit **Test · WebDAV**, test the connection, and save it. Edit it again to verify saved credentials stay
   hidden and are retained when unchanged.
2. Open Memory Drive. Network tools should show `/storage/roots` only, until a
   root is expanded. Expand **Test · WebDAV** and open `Matters/Acquisition`; each expansion requests only
   that folder's `/children` endpoint.
3. Select a writable folder, upload files, and create a folder. Drop a file on
   a folder to test drag-and-drop. A duplicate upload must not replace a file.
4. Open `Deal notes.txt` or `Draft agreement.docx`, edit, and save. Reopen the
   source file to check the update. Close a dirty editor to test the discard
   confirmation. Change the WebDAV fixture file in `files/Demo` before saving a
   draft to test the conflict message and preservation of unsaved text.
5. Open **Test · FTPS**. Reads work; uploads and edits are unavailable.

Stop the terminal processes with Ctrl-C and run
`docker compose -f scripts/storage-fixtures/compose.yml down` when finished.
Only remove `/tmp/legalwork-storage-fixtures` after downloading any test edits
you want to retain. The fixtures intentionally do not auto-delete test content.
