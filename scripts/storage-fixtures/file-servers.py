# /// script
# dependencies = ["wsgidav==4.3.3", "cheroot==11.1.2", "asyncssh==2.21.1", "pyftpdlib==2.1.0", "pyopenssl==25.3.0"]
# ///
"""Loopback-only WebDAV, FTP/FTPS, and SFTP fixtures. Run with `uv run`.

All accounts and generated files belong to this temporary test fixture.
The SFTP server prints the generated host key fingerprint for the test runner.
"""
import asyncio
import json
import os
import threading
from pathlib import Path

import asyncssh
from cheroot.wsgi import Server
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.ioloop import IOLoop
from pyftpdlib.servers import FTPServer
from wsgidav.wsgidav_app import WsgiDAVApp
from OpenSSL import crypto

ROOT = Path(os.environ.get("LEGALWORK_STORAGE_FIXTURES", "/tmp/legalwork-storage-fixtures"))
FILES = ROOT / "files"
FILES.mkdir(parents=True, exist_ok=True)
(FILES / "Matters" / "Acquisition").mkdir(parents=True, exist_ok=True)
(FILES / "Welcome.txt").write_text("Welcome to the firm's connected storage.\n")
(FILES / "Matters" / "Acquisition" / "Deal notes.txt").write_text("Review the draft agreement before Friday.\n")
USER, PASSWORD = "legalwork", "fixture-password"


def dav():
    app = WsgiDAVApp({"provider_mapping": {"/": str(FILES)}, "simple_dc": {"user_mapping": {"*": {USER: {"password": PASSWORD}}}}, "http_authenticator": {"accept_basic": True, "accept_digest": False, "default_to_digest": False}, "verbose": 1})
    Server(("127.0.0.1", 19280), app).start()


def ftp(tls=False):
    auth = DummyAuthorizer()
    auth.add_user(USER, PASSWORD, str(FILES), perm="elradfmwMT")
    class Handler(TLS_FTPHandler if tls else FTPHandler):
        authorizer = auth
    if tls:
        key = crypto.PKey(); key.generate_key(crypto.TYPE_RSA, 2048)
        cert = crypto.X509(); cert.get_subject().CN = "localhost"
        cert.set_serial_number(1); cert.gmtime_adj_notBefore(0); cert.gmtime_adj_notAfter(86400)
        cert.set_issuer(cert.get_subject()); cert.set_pubkey(key)
        cert.add_extensions([crypto.X509Extension(b"subjectAltName", False, b"DNS:localhost,IP:127.0.0.1"), crypto.X509Extension(b"basicConstraints", True, b"CA:TRUE")]); cert.sign(key, "sha256")
        cert_path = ROOT / "ftps-cert.pem"; key_path = ROOT / "ftps-key.pem"
        cert_path.write_bytes(crypto.dump_certificate(crypto.FILETYPE_PEM, cert)); key_path.write_bytes(crypto.dump_privatekey(crypto.FILETYPE_PEM, key)); key_path.chmod(0o600)
        Handler.certfile = str(cert_path); Handler.keyfile = str(key_path)
        Handler.tls_control_required = True; Handler.tls_data_required = True
    FTPServer(("127.0.0.1", 19243 if tls else 19221), Handler, ioloop=IOLoop()).serve_forever()


class SSHServer(asyncssh.SSHServer):
    def begin_auth(self, username): return True
    def password_auth_supported(self): return True
    def validate_password(self, username, password): return username == USER and password == PASSWORD


async def main():
    key = asyncssh.generate_private_key("ssh-ed25519")
    (ROOT / "sftp-fingerprint.txt").write_text(key.get_fingerprint())
    await asyncssh.create_server(SSHServer, "127.0.0.1", 19222, server_host_keys=[key], sftp_factory=lambda chan: asyncssh.SFTPServer(chan, chroot=str(FILES)))
    print(json.dumps({"ready": True, "webdav": 19280, "ftp": 19221, "ftps": 19243, "sftp": 19222, "fingerprint": key.get_fingerprint()}), flush=True)
    await asyncio.Future()


for function in (dav, ftp, lambda: ftp(True)):
    threading.Thread(target=function, daemon=True).start()
asyncio.run(main())
