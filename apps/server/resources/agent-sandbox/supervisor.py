"""One VM, independently namespaced command workers and host broker channels."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time

sys.path.insert(0, '/opt/legalwork')
from relay import connect_host_channel
from protocol import emit, read_frame, write_frame
import network

WORKERS = {}
LOCK = threading.Lock()
CGROUP = Path('/sys/fs/cgroup/commands')


def configure_resources():
    # Keep the channel supervisor alive if commands exhaust their shared budget.
    Path('/proc/self/oom_score_adj').write_text('-1000')
    subprocess.run(['mount', '-t', 'cgroup2', 'none', '/sys/fs/cgroup'], check=True)
    Path('/sys/fs/cgroup/cgroup.subtree_control').write_text('+memory +pids +cpu')
    CGROUP.mkdir()
    CGROUP.joinpath('cgroup.subtree_control').write_text('+memory +pids +cpu')
    available = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()
                     if line.startswith('MemAvailable:'))
    CGROUP.joinpath('memory.max').write_text(str(available * 85 // 100))
    CGROUP.joinpath('pids.max').write_text('4096')


class Worker:
    def __init__(self, ident, config, uid):
        self.ident = ident
        self.write_lock = threading.Lock()
        self.group = CGROUP / ident
        self.group.mkdir()
        self.group.joinpath('memory.oom.group').write_text('1')
        self.group.joinpath('pids.max').write_text('512')
        mode = config.get('networkMode')
        if mode not in ('allow', 'block', 'approve'):
            raise ValueError('Invalid network mode')
        self.network = network.CommandNetwork(ident) if mode == 'allow' else None
        netns = ['/sbin/ip', 'netns', 'exec', ident] if self.network else []
        self.process = subprocess.Popen([
            '/bin/busybox', 'sh', '-ec',
            'echo $$ > "$1/cgroup.procs"; shift; exec "$@"', 'worker', str(self.group),
            *netns, '/usr/bin/unshare', '--mount', '--pid', '--fork', '--kill-child=SIGKILL',
            *([] if self.network else ['--net']), '--ipc', '--uts', '--mount-proc',
            '/usr/local/bin/python3', '-I', '-u', '/opt/legalwork/relay.py', '--worker'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            self.send({**config, "uid": uid, "gid": uid})
        except Exception:
            self.stop()
            self.process.wait()
            self.clean_group()
            raise

    def send(self, message):
        with self.write_lock:
            write_frame(message, self.process.stdin)

    def stop(self):
        # cgroup.kill includes detached descendants, not just the shell group.
        self.group.joinpath('cgroup.kill').write_text('1')
        if self.process.poll() is None:
            self.process.kill()

    def clean_group(self):
        self.group.joinpath('cgroup.kill').write_text('1')
        deadline = time.monotonic() + 5
        while 'populated 1' in self.group.joinpath('cgroup.events').read_text():
            if time.monotonic() >= deadline:
                raise TimeoutError('Command processes did not stop')
            time.sleep(.01)
        self.group.rmdir()
        if self.network:
            self.network.close()

    def supervise(self):
        final = {'event': 'error', 'message': 'Protected command stopped before completion (possibly its memory or process budget).'}
        try:
            while True:
                event = read_frame(self.process.stdout, allow_eof=True)
                if event is None:
                    break
                if event['event'] == 'ready':
                    if event['protocol'] != 2:
                        raise ValueError('Worker protocol mismatch')
                elif event['event'] in ('exit', 'error'):
                    final = event
                else:
                    # The identity comes from this pipe, never from command output.
                    emit({'run': self.ident, 'payload': event})
            self.process.wait()
        except Exception as error:
            final = {'event': 'error', 'message': str(error)}
        finally:
            self.stop()
            self.process.wait()
            try:
                self.clean_group()
            except Exception:
                # A failed cleanup invalidates the whole VM, never publish files.
                os._exit(125)
            self.process.stdin.close()
            self.process.stdout.close()
            with LOCK:
                WORKERS.pop(self.ident, None)
            # No command process or future RPC survives this completion event.
            emit({'run': self.ident, 'payload': final})


def main():
    connect_host_channel()
    configure_resources()
    network.configure()
    emit({'protocol': 5})
    uid = 1000
    while True:
        message = read_frame()
        ident = message['run']
        if not re.fullmatch('[a-f0-9]{32}', ident):
            raise ValueError('Invalid command identity')
        if message['op'] == 'run':
            with LOCK:
                if ident in WORKERS:
                    raise ValueError('Duplicate command identity')
                # Never reuse identities during this VM's lifetime: kernel user
                # resources (for example keyrings) are not all PID-namespaced.
                uid += 1
                if uid >= 2**31:
                    raise ValueError('Command identity space exhausted')
                worker = Worker(ident, message['config'], uid)
                WORKERS[ident] = worker
            threading.Thread(target=worker.supervise, daemon=True).start()
        else:
            with LOCK:
                worker = WORKERS.get(ident)
            if worker:
                try:
                    if message['op'] == 'cancel':
                        worker.stop()
                    elif message['op'] == 'reply':
                        worker.send(message['payload'])
                    else:
                        raise ValueError('Invalid operation')
                except (BrokenPipeError, ProcessLookupError, FileNotFoundError):
                    pass


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        # Losing the host channel shuts down this VM and all namespaces.
        os._exit(125)
