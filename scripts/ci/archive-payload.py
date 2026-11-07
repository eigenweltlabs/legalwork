"""Verify a release tarball preserves every packaged file, link and permission."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tarfile


def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(chunk)
    return result.hexdigest()


def payload(root):
    entries = {}

    def visit(directory):
        for item in sorted(directory.iterdir()):
            name = item.relative_to(root).as_posix()
            metadata = item.lstat()
            value = {"mode": stat.S_IMODE(metadata.st_mode)}
            if item.is_symlink():
                value.update(type="symlink", target=os.readlink(item))
            elif item.is_dir():
                value.update(type="directory")
                visit(item)
            elif item.is_file():
                with item.open("rb") as stream:
                    value.update(type="file", sha256=digest(stream))
            else:
                raise ValueError(f"Unexpected packaged entry: {name}")
            entries[name] = value

    visit(root)
    return entries


def verify(archive, expected):
    prefix = archive.name.removesuffix(".tar.gz")
    entries = {}
    with tarfile.open(archive, "r:gz") as stream:
        for item in stream:
            parts = PurePosixPath(item.name).parts
            if ".." in parts or not parts or parts[0] != prefix:
                raise ValueError(f"Unexpected archive path: {item.name}")
            name = PurePosixPath(*parts[1:]).as_posix()
            if name == ".":
                if not item.isdir():
                    raise ValueError("Archive root must be a directory")
                continue
            if name in entries:
                raise ValueError(f"Duplicate archive entry: {name}")
            value = {"mode": item.mode}
            if item.issym():
                value.update(type="symlink", target=item.linkname)
            elif item.isdir():
                value.update(type="directory")
            elif item.isfile() or item.islnk():
                if item.islnk() and (".." in PurePosixPath(item.linkname).parts or not item.linkname.startswith(prefix + "/")):
                    raise ValueError("Hard links must remain inside this archive")
                with stream.extractfile(item) as content:
                    value.update(type="file", sha256=digest(content))
            else:
                raise ValueError(f"Unexpected archive entry: {name}")
            entries[name] = value
    if entries != expected:
        missing = sorted(expected.keys() - entries.keys())
        extra = sorted(entries.keys() - expected.keys())
        changed = sorted(name for name in expected.keys() & entries.keys() if expected[name] != entries[name])
        raise ValueError(f"Packaged payload differs: missing={missing[:5]}, extra={extra[:5]}, changed={changed[:5]}")


if __name__ == "__main__":
    command, source, manifest = sys.argv[1:]
    if command == "seal":
        Path(manifest).write_text(json.dumps(payload(Path(source)), sort_keys=True) + "\n")
    elif command == "verify":
        expected = json.loads(Path(manifest).read_text())
        verify(Path(source), expected)
        print(json.dumps({"verifiedEntries": len(expected), "payloadManifestSha256": hashlib.sha256(Path(manifest).read_bytes()).hexdigest()}))
    else:
        raise ValueError("Use seal <directory> <manifest> or verify <tar.gz> <manifest>")
