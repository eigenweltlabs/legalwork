"""Isolated command worker. Its supervisor routes bounded JSON to the host.

Restricted VMs have no network interface. Unprivileged commands use this local
HTTP proxy to send complete HTTP requests to the host permission broker.
CONNECT is terminated here, never forwarded as an unrestricted TCP tunnel.
"""
import base64
import errno
import http.server
import importlib.util
import ipaddress
import json
import os
import queue
import re
import signal
import ssl
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

MAX_BODY = 4 * 1024 * 1024
MAX_FRAME = 24 * 1024 * 1024
OUT = threading.Lock()
PENDING = {}
PENDING_LOCK = threading.Lock()
CERT_LOCK = threading.Lock()


def host_channel_path(ports=Path('/sys/class/virtio-ports')):
    # Adding a PCI NIC changes virtio device numbering on x86. Identify the
    # host channel by its configured name, never by its enumeration index.
    for port in ports.glob('vport*'):
        if (port / 'name').read_text().strip() == 'org.legalwork.rpc':
            return str(Path('/dev') / port.name)
    raise FileNotFoundError(errno.ENOENT, 'Host channel is not available')


def connect_host_channel():
    # devtmpfs can publish the port before virtio's host-connected event. A
    # shell redirection fails fatally on ENXIO, so retry the actual open here.
    deadline = time.monotonic() + 60
    while True:
        try:
            descriptor = os.open(host_channel_path(), os.O_RDWR)
            break
        except OSError as error:
            if error.errno not in (errno.ENOENT, errno.ENXIO) or time.monotonic() >= deadline:
                raise
            time.sleep(0.1)
    # Open the exclusive character device once, then duplicate its descriptor.
    os.dup2(descriptor, 0)
    os.dup2(descriptor, 1)
    if descriptor > 2:
        os.close(descriptor)


def emit(message):
    with OUT:
        # virtio-serial is a character device: even a blocking write can be
        # short. Python's unbuffered TextIOWrapper does not retry that tail.
        remaining = memoryview((json.dumps(message, separators=(",", ":")) + "\n").encode())
        while remaining:
            written = os.write(sys.stdout.fileno(), remaining)
            if written <= 0:
                raise OSError("Host channel closed during write")
            remaining = remaining[written:]


def read_frame():
    line = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if not line or len(line) > MAX_FRAME or not line.endswith(b"\n"):
        raise ValueError("Host channel closed or invalid frame")
    return json.loads(line)


def replies():
    try:
        while True:
            message = read_frame()
            with PENDING_LOCK:
                target = PENDING.get(message.get("id"))
            if target:
                target.put_nowait(message)
    except Exception:
        # Parent died or protocol failed: end PID 1, killing all descendants.
        os._exit(125)


def request_host(request, event="request"):
    ident = uuid.uuid4().hex
    target = queue.Queue(maxsize=1)
    with PENDING_LOCK:
        if len(PENDING) >= 16:
            raise ValueError("Too many simultaneous host requests")
        PENDING[ident] = target
    try:
        emit({"event": event, "id": ident, "request": request})
        result = target.get(timeout=300)
        if "error" in result:
            raise ValueError(result["error"])
        return result["response"]
    finally:
        with PENDING_LOCK:
            PENDING.pop(ident, None)


def openssl(*args):
    subprocess.run(["/usr/bin/openssl", *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def certificate(host):
    if not re.fullmatch(r"[a-zA-Z0-9.:-]{1,253}", host):
        raise ValueError("Invalid TLS hostname")
    with CERT_LOCK:
        filename = "/tmp/private/" + uuid.uuid4().hex
        try:
            ipaddress.ip_address(host)
            alternative = "IP:" + host
        except ValueError:
            alternative = "DNS:" + host
        with open(filename + ".ext", "w") as file:
            file.write("subjectAltName=" + alternative + "\nextendedKeyUsage=serverAuth\n"
                       "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
                       "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n")
        openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                "-keyout", filename + ".key", "-out", filename + ".csr", "-subj", "/CN=" + host)
        openssl("x509", "-req", "-in", filename + ".csr", "-CA", "/tmp/public/ca.pem",
                "-CAkey", "/tmp/private/ca.key", "-set_serial", str(uuid.uuid4().int),
                "-days", "1", "-extfile", filename + ".ext", "-out", filename + ".pem")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(filename + ".pem", filename + ".key")
        for suffix in [".key", ".csr", ".pem", ".ext"]:
            os.unlink(filename + suffix)
        return context


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    tls_authority = None

    def log_message(self, *_args):
        pass

    def setup(self):
        self.request.settimeout(300)
        super().setup()

    def do_CONNECT(self):
        try:
            if self.tls_authority is not None:
                raise ValueError("Nested tunnels are forbidden")
            target = urlsplit("https://" + self.path)
            if not target.hostname or target.username or target.password or target.path or target.query or target.fragment:
                raise ValueError("Invalid CONNECT target")
            port = target.port or 443
            if port != 443:
                raise ValueError("HTTPS tunnelling is limited to port 443")
            context = certificate(target.hostname)
            self.send_response(200, "Connection established")
            self.end_headers()
            self.wfile.flush()
            self.connection = context.wrap_socket(self.connection, server_side=True)
            self.rfile = self.connection.makefile("rb", buffering=0)
            self.wfile = self.connection.makefile("wb", buffering=0)
            self.tls_authority = target.netloc
            self.handle_one_request()
        except Exception:
            pass
        finally:
            self.close_connection = True

    def body(self):
        lengths = self.headers.get_all("Content-Length", [])
        encodings = self.headers.get_all("Transfer-Encoding", [])
        if len(lengths) > 1 or len(encodings) > 1 or (lengths and encodings):
            raise ValueError("Ambiguous request framing")
        if encodings:
            if encodings[0].lower() != "chunked":
                raise ValueError("Unsupported transfer encoding")
            parts, size = [], 0
            while True:
                line = self.rfile.readline(128)
                if not re.fullmatch(rb"[0-9a-fA-F]+\r\n", line):
                    raise ValueError("Invalid chunk")
                length = int(line, 16)
                size += length
                if size > MAX_BODY:
                    raise ValueError("Request too large")
                if length == 0:
                    if self.rfile.readline(8192) != b"\r\n":
                        raise ValueError("Request trailers are unsupported")
                    break
                part = self.rfile.read(length)
                if len(part) != length or self.rfile.read(2) != b"\r\n":
                    raise ValueError("Truncated chunk")
                parts.append(part)
            return b"".join(parts)
        length = int(lengths[0]) if lengths else 0
        if not 0 <= length <= MAX_BODY:
            raise ValueError("Request too large")
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError("Truncated request")
        return body

    def forward(self):
        try:
            if self.tls_authority:
                if not self.path.startswith("/") or self.path.startswith("//"):
                    raise ValueError("HTTPS requires an origin-form path")
                url = "https://" + self.tls_authority + self.path
            else:
                if urlsplit(self.path).scheme != "http":
                    raise ValueError("Use CONNECT for HTTPS")
                url = self.path
            headers = {}
            for name, value in self.headers.items():
                lower = name.lower()
                if lower in headers:
                    raise ValueError("Duplicate request headers are unsupported")
                headers[lower] = value
            result = request_host({"url": url, "method": self.command, "headers": headers,
                                   "bodyBase64": base64.b64encode(self.body()).decode("ascii")})
            body = base64.b64decode(result["bodyBase64"], validate=True)
            self.send_response(result["status"])
            for key, value in result["headers"].items():
                if key.lower() not in ["content-length", "connection", "transfer-encoding"]:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except Exception as error:
            self.send_error(403, "Blocked by LegalWork", str(error))
        finally:
            self.close_connection = True

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = forward


def pump(stream, name):
    while chunk := stream.read1(8192):
        emit({"event": "output", "stream": name, "data": base64.b64encode(chunk).decode("ascii")})


def start_filesystem(mounts, uid, gid):
    spec = importlib.util.spec_from_file_location("approved_filesystem", "/opt/legalwork/filesystem.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    os.makedirs("/mnt/approved", exist_ok=True)

    def serve():
        try:
            module.serve(mounts, request_host, uid, gid)
        except Exception as error:
            emit({"event": "error", "message": "Protected filesystem failed: " + str(error)})
            os._exit(125)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    deadline = time.monotonic() + 30
    while not os.path.ismount("/mnt/approved"):
        if time.monotonic() > deadline:
            raise TimeoutError("Protected filesystem did not start")
        time.sleep(0.01)
    return thread


def isolate_worker():
    # unshare already created private mount, PID, network, IPC and UTS namespaces.
    # Shared packages are read-only; every writable runtime directory is private.
    def mount(*args):
        subprocess.run(['/bin/busybox', 'mount', *args], check=True)
    mount('--make-rprivate', '/')
    if os.path.ismount('/run/netns'):
        subprocess.run(['/bin/umount', '--recursive', '/run/netns'], check=True)
    mount('--bind', '/', '/')
    mount('-o', 'remount,bind,ro', '/')
    for path in ('/tmp', '/run', '/mnt', '/dev', '/sys'):
        mount('-t', 'tmpfs', '-o', 'nosuid,nodev,mode=755', 'tmpfs', path)
    os.chmod('/tmp', 0o1777)
    # Device nodes are private and only these harmless devices are exposed.
    mount('-o', 'remount,dev', '/dev')
    import stat
    for name, major, minor, mode in [('null', 1, 3, 0o666), ('zero', 1, 5, 0o666),
                                     ('random', 1, 8, 0o666), ('urandom', 1, 9, 0o666),
                                     ('fuse', 10, 229, 0o600)]:
        os.mknod('/dev/' + name, stat.S_IFCHR | mode, os.makedev(major, minor))
        os.chmod('/dev/' + name, mode)
    os.mkdir('/dev/shm', 0o1777)
    os.symlink('/proc/self/fd', '/dev/fd')
    for number, name in enumerate(('stdin', 'stdout', 'stderr')):
        os.symlink('/proc/self/fd/' + str(number), '/dev/' + name)
    subprocess.run(['/bin/busybox', 'ip', 'link', 'set', 'lo', 'up'], check=True)


def main():
    startup_timer = threading.Timer(180, lambda: os._exit(124))
    startup_timer.daemon = True
    startup_timer.start()
    config = read_frame()
    isolate_worker()
    # Do not inherit PID 1's OOM exemption into commands.
    with open("/proc/self/oom_score_adj", "w") as file:
        file.write("0")
    emit({"event": "ready", "protocol": 2})
    threading.Thread(target=replies, daemon=True).start()
    uid, gid = config["uid"], config["gid"]
    if not isinstance(uid, int) or not isinstance(gid, int) or uid <= 0 or gid <= 0:
        raise ValueError("Sandbox commands require a non-root identity")
    filesystem = start_filesystem(config["mounts"], uid, gid)
    timer = threading.Timer(config["timeoutMs"] / 1000, lambda: os._exit(124))
    timer.daemon = True
    timer.start()
    startup_timer.cancel()
    os.mkdir("/tmp/private", 0o700)
    os.mkdir("/tmp/public", 0o755)
    os.mkdir("/tmp/home", 0o777)
    os.chmod("/tmp/home", 0o777)
    environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp/home", "TMPDIR": "/tmp/home", "LANG": "C.UTF-8"}
    if config["networkMode"] != "allow":
        openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
                "-keyout", "/tmp/private/ca.key", "-out", "/tmp/public/ca.pem", "-days", "1",
                "-subj", "/CN=LegalWork session proxy", "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 3128), Proxy)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        proxy = "http://127.0.0.1:3128"
        environment.update({"HTTP_PROXY": proxy, "HTTPS_PROXY": proxy,
                       "http_proxy": proxy, "https_proxy": proxy, "NO_PROXY": "", "no_proxy": "",
                       "SSL_CERT_FILE": "/tmp/public/ca.pem", "REQUESTS_CA_BUNDLE": "/tmp/public/ca.pem",
                       "CURL_CA_BUNDLE": "/tmp/public/ca.pem", "NODE_EXTRA_CA_CERTS": "/tmp/public/ca.pem",
                       "NODE_USE_ENV_PROXY": "1", "GIT_SSL_CAINFO": "/tmp/public/ca.pem"})
    child = subprocess.Popen(["/usr/bin/setpriv", "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", f"--reuid={uid}", f"--regid={gid}", "--clear-groups",
                              "/bin/bash", "--noprofile", "--norc", "-c", config["command"]],
                             cwd=config["cwd"], env=environment, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)
    threads = [threading.Thread(target=pump, args=(stream, name), daemon=True)
               for stream, name in [(child.stdout, "stdout"), (child.stderr, "stderr")]]
    for thread in threads:
        thread.start()
    code = child.wait()
    # This PID namespace belongs to one command. Stop its detached descendants.
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                if os.stat("/proc/" + pid).st_uid == uid:
                    os.kill(int(pid), signal.SIGKILL)
            except (ProcessLookupError, FileNotFoundError):
                pass
    for thread in threads:
        thread.join(timeout=2)
    subprocess.run(["/bin/busybox", "umount", "/mnt/approved"], check=True)
    filesystem.join(timeout=5)
    if filesystem.is_alive():
        raise TimeoutError("Protected filesystem did not stop")
    emit({"event": "exit", "code": code})
    # The supervisor confirms the namespace and cgroup are empty before it
    # forwards completion to the host and permits staged writes to be applied.
    os._exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"event": "error", "message": str(error)})
        os._exit(125)
