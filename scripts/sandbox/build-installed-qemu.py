"""Build the shipped emulator and every generated file needed by normal install."""
import json
from pathlib import Path
import subprocess
import sys


def installed_targets(build, installed, available, emulator):
    selected = {emulator}
    if emulator not in available:
        raise ValueError(f"Missing shipped emulator target: {emulator}")
    for filename in installed:
        source = Path(filename).resolve()
        if not source.is_relative_to(build):
            continue  # Meson installs these existing source files directly.
        target = source.relative_to(build).as_posix()
        if target in available:
            selected.add(target)
        elif not source.is_file():
            raise ValueError(f"Missing generated installation prerequisite: {target}")
    return sorted(selected)


if __name__ == "__main__":
    build = Path(sys.argv[1]).resolve()
    installed = json.loads(subprocess.check_output(["meson", "introspect", "--installed", "."], cwd=build, text=True))
    available = {line.split(":", 1)[0] for line in subprocess.check_output(
        ["ninja", "-t", "targets", "all"], cwd=build, text=True).splitlines()}
    targets = installed_targets(build, installed, available, sys.argv[2])
    print(json.dumps({"qemuInstallationTargets": targets}), flush=True)
    subprocess.run(["ninja", "-j3", *targets], cwd=build, check=True)
