"""Extract only bounded ordinary native-cache files, before receipt validation."""
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile

archive, destination = map(Path, sys.argv[1:])
with zipfile.ZipFile(archive) as source:
    files = source.infolist()
    if not 1 <= len(files) <= 30 or sum(item.file_size for item in files) > 64 * 1024 * 1024:
        raise ValueError("Unexpected native cache archive size")
    seen = set()
    for item in files:
        name = PurePosixPath(item.filename)
        mode = stat.S_IFMT(item.external_attr >> 16)
        if (name.is_absolute() or '..' in name.parts or '\\' in item.filename or str(name) != item.filename.rstrip('/')
                or str(name) in seen or mode not in (0, stat.S_IFREG, stat.S_IFDIR)):
            raise ValueError("Native cache entries must be unique ordinary relative paths")
        seen.add(str(name))
        if item.is_dir():
            if str(name) != 'arm64-notices':
                raise ValueError("Unexpected native cache directory")
            continue
        if mode not in (0, stat.S_IFREG):
            raise ValueError("Native cache files must be regular files")
        if not all(re.fullmatch(r'[A-Za-z0-9_.-]+', part) for part in name.parts):
            raise ValueError("Native cache paths cannot contain Windows drives or streams")
        reserved = {'CON', 'PRN', 'AUX', 'NUL', *('COM' + str(i) for i in range(1, 10)), *('LPT' + str(i) for i in range(1, 10))}
        if any(part.split('.')[0].upper() in reserved for part in name.parts):
            raise ValueError("Native cache paths cannot name Windows devices")
        if len(name.parts) > 2 or len(name.parts) == 2 and name.parts[0] != 'arm64-notices':
            raise ValueError("Unexpected native cache path")
        target = destination.joinpath(*name.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open(item) as content, target.open('xb') as output:
            for chunk in iter(lambda: content.read(1024 * 1024), b''):
                output.write(chunk)
