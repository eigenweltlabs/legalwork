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
flag, only the self-contained local/API tests run in the normal server suite.

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
Add a **Folder or network drive** named `Firm files` pointing at
`/tmp/legalwork-storage-fixtures/demo-documents` to test configuration through
the UI. The other six connections are seeded; FTPS is read-only to demonstrate
the disabled write controls.

1. Test a connection and save it. Edit it again to verify saved credentials stay
   hidden and are retained when unchanged.
2. Open Memory Drive. Network tools should show `/storage/roots` only, until a
   root is expanded. Open `Matters/Acquisition`; each expansion requests only
   that folder's `/children` endpoint.
3. Select a writable folder, upload files, and create a folder. Drop a file on
   a folder to test drag-and-drop. A duplicate upload must not replace a file.
4. Open `Deal notes.txt` or `Draft agreement.docx`, edit, and save. Reopen the
   source file to check the update. Close a dirty editor to test the discard
   confirmation. Change a local source file externally before saving a draft
   to test the conflict message and preservation of unsaved text.
5. Open the FTPS archive. Reads work; uploads and edits are unavailable.

Stop the terminal processes with Ctrl-C and run
`docker compose -f scripts/storage-fixtures/compose.yml down` when finished.
Only remove `/tmp/legalwork-storage-fixtures` after downloading any test edits
you want to retain. The fixtures intentionally do not auto-delete test content.
