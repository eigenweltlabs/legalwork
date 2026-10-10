"""Outbound-only networking for explicitly unrestricted command workers.

Restricted runtimes have no NIC. In unrestricted runtimes each worker gets a
private network namespace; the supervisor firewall prevents worker-to-worker
connections and access to the supervisor. QEMU user networking needs no host
administrator setup and publishes no inbound ports.
"""
from pathlib import Path
import subprocess
import threading

ENABLED = False
SLOTS = set()
LOCK = threading.Lock()


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.DEVNULL, **kwargs)


def configure():
    global ENABLED
    if 'legalwork.network=allow' not in Path('/proc/cmdline').read_text().split():
        return
    run('/sbin/modprobe', 'virtio_net')
    run('/sbin/ip', 'link', 'set', 'eth0', 'up')
    run('/sbin/ip', 'addr', 'add', '10.0.2.15/24', 'dev', 'eth0')
    run('/sbin/ip', 'route', 'add', 'default', 'via', '10.0.2.2')
    run('/sbin/ip', '-6', 'addr', 'add', 'fec0::15/64', 'dev', 'eth0', 'nodad')
    run('/sbin/ip', '-6', 'route', 'add', 'default', 'via', 'fec0::2')
    # Install a default-drop firewall before enabling forwarding.
    run('/usr/sbin/nft', '-f', '-', input='''
table inet sandbox {
  chain input {
    type filter hook input priority 0; policy drop;
    iifname "lo" accept
    iifname "eth0" meta l4proto ipv6-icmp accept
    iifname "lw*" meta l4proto ipv6-icmp icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    iifname "lw*" oifname "eth0" accept
    iifname "eth0" oifname "lw*" ct state established,related accept
  }
  chain postrouting {
    type nat hook postrouting priority 100; policy accept;
    oifname "eth0" masquerade
  }
}
''', text=True)
    Path('/proc/sys/net/ipv4/ip_forward').write_text('1')
    Path('/proc/sys/net/ipv6/conf/all/forwarding').write_text('1')
    ENABLED = True


class CommandNetwork:
    def __init__(self, ident):
        if not ENABLED:
            raise ValueError('Unrestricted networking is unavailable in this VM')
        self.name = ident
        with LOCK:
            slot = next((number for number in range(1, 16384) if number not in SLOTS), None)
            if slot is None:
                raise ValueError('No command network addresses available')
            SLOTS.add(slot)
        self.slot = slot
        self.link = 'lw' + str(slot)
        prefix = f'10.201.{slot * 4 // 256}.'
        host = prefix + str(slot * 4 % 256 + 1)
        guest = prefix + str(slot * 4 % 256 + 2)
        subnet6 = f'fd42:6c77:{slot:x}::'
        self.created = False
        self.link_created = False
        try:
            run('/sbin/ip', 'netns', 'add', ident)
            self.created = True
            run('/sbin/ip', 'link', 'add', self.link, 'type', 'veth', 'peer', 'name', 'eth0', 'netns', ident)
            self.link_created = True
            run('/sbin/ip', 'addr', 'add', host + '/30', 'dev', self.link)
            run('/sbin/ip', '-6', 'addr', 'add', subnet6 + '1/64', 'dev', self.link, 'nodad')
            run('/sbin/ip', 'link', 'set', self.link, 'up')
            for args in [
                ['link', 'set', 'lo', 'up'], ['link', 'set', 'eth0', 'up'],
                ['addr', 'add', guest + '/30', 'dev', 'eth0'], ['route', 'add', 'default', 'via', host],
                ['-6', 'addr', 'add', subnet6 + '2/64', 'dev', 'eth0', 'nodad'],
                ['-6', 'route', 'add', 'default', 'via', subnet6 + '1'],
            ]:
                run('/sbin/ip', '-n', ident, *args)
        except Exception:
            self.close()
            raise

    def close(self):
        if self.link_created:
            run('/sbin/ip', 'link', 'delete', self.link)
            self.link_created = False
        if self.created:
            # Explicitly delete the link before reusing its address, even if
            # another mount namespace temporarily retains the netns handle.
            run('/sbin/ip', 'netns', 'delete', self.name)
            self.created = False
        with LOCK:
            SLOTS.remove(self.slot)
