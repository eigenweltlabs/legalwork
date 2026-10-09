"""Guest FUSE adapter. Every host operation is authorized by the host broker.

No host filesystem is attached to QEMU. These callbacks use the same bounded
virtio-serial channel as the network broker, with a separate operation schema.
"""
import errno
import os
import stat
from fuse import FUSE, FuseOSError, Operations

CHUNK = 128 * 1024


class ApprovedFolders(Operations):
    def __init__(self, mounts, request, uid, gid):
        self.request = request
        self.uid, self.gid = uid, gid
        self.mounts = {mount["target"]: mount for mount in mounts}
        self.handles = {}
        self.parents = {"/": ["workspace", "authorized", "skills"], "/authorized": [], "/skills": []}
        for target in self.mounts:
            parent, name = target.rsplit("/", 1)
            if parent in self.parents:
                self.parents[parent].append(name)

    def call(self, op, **kwargs):
        result = self.request({"op": op, **kwargs}, "filesystem")
        if "errno" in result:
            raise FuseOSError(result["errno"])
        return result["result"]

    def path(self, path, handle=None):
        return path or self.handles.get(handle, "/workspace")

    def getattr(self, path, fh=None):
        if path in self.parents:
            return dict(st_mode=stat.S_IFDIR | 0o555, st_nlink=2, st_uid=0, st_gid=0, st_size=4096)
        args = {"path": self.path(path, fh)}
        if fh:
            args["handle"] = fh
        result = self.call("stat", **args)
        result["st_uid"], result["st_gid"] = self.uid, self.gid
        if path in self.mounts and not self.mounts[path]["writable"]:
            result["st_mode"] &= ~0o222
        return result

    def readdir(self, path, fh):
        if path in self.parents:
            return [".", "..", *self.parents[path]]
        names, offset = [".", ".."], 0
        while True:
            response = self.call("list", path=path, offset=offset)
            names.extend(response["names"])
            offset += len(response["names"])
            if not response["more"]:
                return names

    def open(self, path, flags):
        handle = self.call("open", path=path, write=bool(flags & (os.O_WRONLY | os.O_RDWR)),
                           create=bool(flags & os.O_CREAT), exclusive=bool(flags & os.O_EXCL),
                           truncate=bool(flags & os.O_TRUNC))
        self.handles[handle] = path
        return handle

    def create(self, path, mode, fi=None):
        handle = self.open(path, os.O_RDWR | os.O_CREAT | os.O_TRUNC)
        self.call("chmod", path=path, mode=mode)
        return handle

    def read(self, path, size, offset, fh):
        chunks = []
        while size:
            length = min(size, CHUNK)
            data = self.call("read", handle=fh, offset=offset, size=length)
            chunks.append(data)
            if len(data) < length:
                break
            offset += len(data)
            size -= len(data)
        return b"".join(chunks)

    def write(self, path, data, offset, fh):
        for start in range(0, len(data), CHUNK):
            chunk = data[start:start + CHUNK]
            count = self.call("write", handle=fh, offset=offset + start, data=chunk)
            if count != len(chunk):
                raise FuseOSError(errno.EIO)
        return len(data)

    def release(self, path, fh):
        try:
            return self.call("close", handle=fh)
        finally:
            self.handles.pop(fh, None)

    def truncate(self, path, length, fh=None):
        args = {"path": self.path(path, fh), "length": length}
        if fh:
            args["handle"] = fh
        return self.call("truncate", **args)

    def mkdir(self, path, mode):
        return self.call("mkdir", path=path, mode=mode)

    def unlink(self, path):
        return self.call("unlink", path=path)

    def rmdir(self, path):
        return self.call("rmdir", path=path)

    def rename(self, old, new):
        result = self.call("rename", path=old, destination=new)
        for handle, path in self.handles.items():
            if path == old:
                self.handles[handle] = new
        return result

    def chmod(self, path, mode):
        return self.call("chmod", path=path, mode=mode)

    def chown(self, path, uid, gid):
        if uid not in (-1, self.uid) or gid not in (-1, self.gid):
            raise FuseOSError(errno.EPERM)
        return 0

    def utimens(self, path, times=None):
        # Host timestamps are not preserved by protected command execution.
        return 0

    def flush(self, path, fh):
        return 0

    def fsync(self, path, datasync, fh):
        return 0

    def statfs(self, path):
        space = self.call("space")
        return dict(f_bsize=4096, f_frsize=4096, f_blocks=space["budget"] // 4096,
                    f_bfree=space["available"] // 4096, f_bavail=space["available"] // 4096,
                    f_files=100000, f_ffree=100000, f_favail=100000, f_namemax=255)


def serve(mounts, request, uid, gid):
    FUSE(ApprovedFolders(mounts, request, uid, gid), "/mnt/approved", foreground=True, nothreads=True,
         allow_other=True, default_permissions=True, nosuid=True, nodev=True,
         attr_timeout=0, entry_timeout=0, negative_timeout=0,
         big_writes=True, max_read=CHUNK, max_write=CHUNK)
