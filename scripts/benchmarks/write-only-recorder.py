#!/usr/bin/env python3
"""Linux-only, controller/root-owned append sink. No read/list HTTP or socket API.

SO_PEERCRED authenticates the connecting process, including rejecting a child
which inherited the engine's uid. Full journal bytes stay in a 0700 root tree.
One event per connection, durable append before ACK, no event-size limit/retry.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import stat
import struct
import threading
import time


def sha256_file(path):
    result = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def process_identity(pid):
    directory = Path("/proc") / str(pid)
    # comm may contain spaces/parentheses; starttime is field22 after the last ).
    fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
    executable = os.path.realpath(directory / "exe")
    info = os.stat(directory / "exe")
    return {"pid": pid, "startTimeTicks": fields[19], "executable": executable,
            "fileIdentity": [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns],
            "owner": info.st_uid, "mode": stat.S_IMODE(info.st_mode)}


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "w", encoding="utf8") as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    fsync_directory(path.parent)


class Recorder:
    def __init__(self, config):
        if os.geteuid() != 0 or not hasattr(socket, "SO_PEERCRED"):
            raise RuntimeError("Linux root and SO_PEERCRED are required")
        self.config = config
        self.binding = config["binding"]
        self.initial_identity = process_identity(self.binding["pid"])
        for key in ["startTimeTicks", "executable"]:
            if str(self.initial_identity[key]) != str(self.binding[key]):
                raise RuntimeError("Configured engine identity changed")
        if self.initial_identity["owner"] != 0 or self.initial_identity["mode"] & 0o022:
            raise RuntimeError("Bound executable must be root-owned and not group/world writable")
        if sha256_file(f'/proc/{self.binding["pid"]}/exe') != self.binding["executableSha256"]:
            raise RuntimeError("Configured engine executable SHA differs")
        self.directory = Path(config["directory"])
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        os.chmod(self.directory, 0o700)
        fsync_directory(self.directory.parent)
        self.lock = threading.Lock()
        self.health = {"contractVersion": 4, "kind": "linux-peercred-write-only", "binding": self.binding,
                       "initialIdentity": self.initial_identity, "observers": {}, "errors": [], "rejections": [],
                       "outputCaps": False, "automaticRetries": 0, "readAPI": False, "appendMs": 0,
                       "durableBeforeAcknowledgment": True, "bytes": 0}
        self.publish()

    def publish(self):
        self.health["updatedAtUnixNs"] = time.time_ns()
        atomic_json(self.directory / "health.json", self.health)

    def authorized(self, connection):
        pid, uid, gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        if [pid, uid, gid] != [self.binding["pid"], self.binding["uid"], self.binding["gid"]]:
            return False, {"pid": pid, "uid": uid, "gid": gid, "reason": "peer-not-bound-engine"}
        try:
            actual = process_identity(pid)
            if actual != self.initial_identity:
                return False, {"pid": pid, "reason": "engine-identity-changed"}
        except OSError:
            return False, {"pid": pid, "reason": "engine-no-longer-exists"}
        return True, {"pid": pid, "uid": uid, "gid": gid}

    def append(self, request):
        started = time.monotonic_ns()
        if request.get("kind") != "append" or set(request) != {"kind", "payload", "recordSha256"}:
            raise ValueError("append-only-protocol")
        serialized, record_hash = request["payload"], request["recordSha256"]
        if not isinstance(serialized, str) or hashlib.sha256(serialized.encode()).hexdigest() != record_hash:
            raise ValueError("event-hash-mismatch")
        record = json.loads(serialized)
        observer = record["observerInstance"]
        if not isinstance(observer, str) or not re.fullmatch(r"[0-9a-f-]{36}", observer):
            raise ValueError("observer-identity-invalid")
        if record.get("phase") not in ["observer.ready", "before", "after"] or record.get("location") not in self.config["locations"]:
            raise ValueError("event-location-or-phase-invalid")
        if record["phase"] == "observer.ready":
            if observer in self.health["observers"] or record["sequence"] != 0 or record["previousSha256"] is not None:
                raise ValueError("observer-registration-conflict")
            atomic_json(self.directory / f"registration.{observer}.json", {"payload": record, "recordSha256": record_hash})
            events_name = f"events.{observer}.jsonl"
            with open(self.directory / events_name, "xb") as journal:
                os.chmod(journal.name, 0o600)
                journal.flush()
                os.fsync(journal.fileno())
            self.health["observers"][observer] = {"sequence": 0, "lastSha256": None, "bytes": 0,
                                                  "eventsName": events_name, "registrationSha256": record_hash}
            self.publish()
            return {"ok": True, "sequence": 0, "recordSha256": record_hash}
        previous = self.health["observers"].get(observer)
        if previous is None:
            raise ValueError("observer-not-registered")
        if record["sequence"] != previous["sequence"] + 1 or record["previousSha256"] != previous["lastSha256"]:
            raise ValueError("event-sequence-or-chain-mismatch")
        if not serialized.endswith("}"):
            raise ValueError("event-payload-not-object")
        line = (serialized[:-1] + ',"recordSha256":' + json.dumps(record_hash) + '}\n').encode()
        path = self.directory / f"events.{observer}.jsonl"
        with open(path, "ab") as journal:
            os.chmod(path, 0o600)
            journal.write(line)
            journal.flush()
            os.fsync(journal.fileno())
        self.health["observers"][observer] = {"sequence": record["sequence"], "lastSha256": record_hash,
                                                "bytes": previous["bytes"] + len(line), "eventsName": path.name,
                                                "registrationSha256": previous["registrationSha256"]}
        self.health["bytes"] += len(line)
        self.health["appendMs"] += (time.monotonic_ns() - started) / 1000000
        self.publish()
        return {"ok": True, "sequence": record["sequence"], "recordSha256": record_hash}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config_path = Path(args.config)
    config_stat = config_path.stat()
    if config_stat.st_uid != 0 or stat.S_IMODE(config_stat.st_mode) & 0o077:
        raise RuntimeError("Recorder config must be root-private")
    config = json.loads(config_path.read_text())
    recorder = Recorder(config)
    socket_path = Path(config["socketPath"])
    socket_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    parent = socket_path.parent.stat()
    if parent.st_uid != 0 or stat.S_IMODE(parent.st_mode) & 0o022 or socket_path.exists():
        raise RuntimeError("Socket parent must be root-controlled and socket must be new")

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            with recorder.lock:
                allowed, peer = recorder.authorized(self.connection)
                if not allowed:
                    recorder.health["rejections"].append({**peer, "atUnixNs": time.time_ns()})
                    recorder.publish()
            if not allowed:
                self.wfile.write(b'{"ok":false,"error":"peer-not-authorized"}\n')
                return
            try:
                # readline has intentionally no size argument: transport chunks
                # do not impose an event/output limit.
                raw = self.rfile.readline()
                if not raw.endswith(b"\n"):
                    raise ValueError("torn-append-request")
                with recorder.lock:
                    acknowledgment = recorder.append(json.loads(raw))
                self.wfile.write((json.dumps(acknowledgment, separators=(",", ":")) + "\n").encode())
                self.wfile.flush()
            except Exception as error:
                with recorder.lock:
                    recorder.health["errors"].append({"operation": "append-or-ack", "type": type(error).__name__, "atUnixNs": time.time_ns()})
                    try:
                        recorder.publish()
                    except OSError:
                        pass
                try:
                    self.wfile.write(b'{"ok":false,"error":"capture-incomplete"}\n')
                except OSError:
                    pass

    class Server(socketserver.ThreadingUnixStreamServer):
        daemon_threads = True
        allow_reuse_address = False

    with Server(str(socket_path), Handler) as server:
        os.chmod(socket_path, 0o666)  # peer credentials, not a shared token, authorize appends
        def stop(_signum, _frame):
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        server.serve_forever()
    socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
