#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  ucrt64) package=mingw-w64-ucrt-x86_64 ;;
  clangarm64) package=mingw-w64-clang-aarch64 ;;
  *) echo 'Expected ucrt64 or clangarm64' >&2; exit 1 ;;
esac

retry() {
  local attempt
  for attempt in 1 2 3; do
    if "$@"; then return 0; fi
    if [ "$attempt" -lt 3 ]; then sleep 5; fi
  done
  return 1
}

pins="$(cd "$(dirname "$0")" && pwd)/qemu-windows.sha256"
download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
grep "  ${package}-" "$pins" > "$download/SHA256SUMS"

# Keep the executable, firmware and companion packages on the reviewed release.
# pacman -S qemu follows the rolling repository and can silently change versions.
archives=()
while read -r checksum filename; do
  url="https://repo.msys2.org/mingw/$1/$filename"
  curl -fL --retry 3 --connect-timeout 30 "$url" -o "$download/$filename"
  curl -fL --retry 3 --connect-timeout 30 "$url.sig" -o "$download/$filename.sig"
  archives+=("$download/$filename")
done < "$download/SHA256SUMS"
(cd "$download" && sha256sum -c SHA256SUMS)

retry pacman -S --noconfirm --needed "${package}-cc"
# Install all pinned QEMU packages in one transaction, preserving signature checks.
retry pacman -U --noconfirm --needed "${archives[@]}"
