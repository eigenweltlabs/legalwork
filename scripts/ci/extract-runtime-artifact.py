"""Unpack the one retained native runtime, without links or path traversal."""
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
import zipfile

archive, destination = sys.argv[1:]
root = Path(destination)
root.mkdir(parents=True)
with zipfile.ZipFile(archive) as outer:
    if outer.namelist() != ["sandbox-runtime.tgz"]:
        raise ValueError("Expected exactly one native runtime archive")
    seen = set()
    total = 0
    with outer.open("sandbox-runtime.tgz") as compressed, tarfile.open(fileobj=compressed, mode="r|gz") as payload:
        for member in payload:
            if member.name in [".", "./"] and member.isdir():
                continue
            name = member.name.removeprefix("./")
            if not re.fullmatch(r"[A-Za-z0-9_.+-]+", name) or name in [".", ".."] or not member.isfile() or name in seen:
                raise ValueError("Runtime entries must be unique ordinary files at the archive root")
            total += member.size
            if total > 2 * 1024**3 or len(seen) >= 1000:
                raise ValueError("Unexpected native runtime archive size")
            seen.add(name)
            with payload.extractfile(member) as content, (root / name).open("xb") as output:
                shutil.copyfileobj(content, output)
            os.chmod(root / name, member.mode & 0o777)
