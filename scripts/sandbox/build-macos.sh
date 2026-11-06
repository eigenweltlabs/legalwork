#!/usr/bin/env bash
# Build every shipped library against the app's macOS floor. Homebrew bottles
# inherit the runner's newer OS requirement even when QEMU targets macOS 12.
set -euo pipefail
arch="${1:?Pass aarch64 or x86_64}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="${RUNNER_TEMP:-${TMPDIR:-/tmp}/legalwork-sandbox-build}"
mkdir -p "$work/sandbox-source" "$work/qemu-deps/share/licenses"
export MACOSX_DEPLOYMENT_TARGET=12.0
export MAKE=/usr/bin/make
export CC=/usr/bin/clang
export CXX=/usr/bin/clang++
export CFLAGS='-O2 -mmacosx-version-min=12.0'
export CXXFLAGS="$CFLAGS"
export OBJCFLAGS="$CFLAGS"
export LDFLAGS='-mmacosx-version-min=12.0'
export PKG_CONFIG_LIBDIR="$work/qemu-deps/lib/pkgconfig:$work/qemu-deps/share/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
export PATH="$work/sandbox-tools/bin:$PATH"
python3 -m venv "$work/sandbox-tools"
"$work/sandbox-tools/bin/python" -I -S "$root/apps/server/resources/agent-sandbox/bootstrap-pip.py"
"$work/sandbox-tools/bin/pip" install --disable-pip-version-check meson==1.10.0
source_archive() {
  local name="$1" url="$2" hash="$3"
  local file="$work/sandbox-source/${url##*/}"
  if [ ! -f "$file" ]; then
    if ! curl -fL --retry 2 --connect-timeout 20 --max-time 180 "$url" -o "$file"; then
      # GNU's primary server is intermittently unreachable from hosted Macs.
      # A mirror serves the same pinned archive, still verified below.
      [ -n "${4:-}" ] || return 1
      curl -fL --retry 2 --connect-timeout 20 --max-time 180 "$4" -o "$file"
    fi
  fi
  echo "$hash  $file" | shasum -a 256 -c -
  tar -xf "$file" -C "$work/sandbox-source"
  mkdir -p "$work/qemu-deps/share/licenses/$name"
  for license in "$work/sandbox-source/$name"/{COPYING*,LICENSE*,LICENCE*}; do
    if [ -f "$license" ]; then cp "$license" "$work/qemu-deps/share/licenses/$name/"; fi
  done
}
source_archive libffi-3.8.0 https://github.com/libffi/libffi/releases/download/v3.8.0/libffi-3.8.0.tar.gz 7da3e2d9a171eb0a038f592ecad3ff2bb2550f3496d87b3b29ad0cf4430c0db4
(cd "$work/sandbox-source/libffi-3.8.0"; ./configure --prefix="$work/qemu-deps" --disable-static --disable-docs --disable-multi-os-directory; make -j3; make install)
source_archive pcre2-10.49 https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.49/pcre2-10.49.tar.bz2 53c156e1ba416a20da8e65395daa132da0d80e76910424caca3fcdae7831d384
(cd "$work/sandbox-source/pcre2-10.49"; ./configure --prefix="$work/qemu-deps" --disable-static --disable-pcre2grep --disable-pcre2test; make -j3; make install)
source_archive gettext-1.0 https://ftp.gnu.org/gnu/gettext/gettext-1.0.tar.gz 85d99b79c981a404874c02e0342176cf75c7698e2b51fe41031cf6526d974f1a https://mirrors.kernel.org/gnu/gettext/gettext-1.0.tar.gz
(cd "$work/sandbox-source/gettext-1.0/gettext-runtime"; ./configure --prefix="$work/qemu-deps" --disable-static --disable-java --disable-csharp; make -j3; make install)
export CFLAGS="$CFLAGS -I$work/qemu-deps/include"
export CXXFLAGS="$CXXFLAGS -I$work/qemu-deps/include"
export LDFLAGS="$LDFLAGS -L$work/qemu-deps/lib"
source_archive glib-2.90.1 https://download.gnome.org/sources/glib/2.90/glib-2.90.1.tar.xz 93c941aa17d5eb1d53fe838365f29a8b4e539c222a256d974ec8f30fc413e396
meson setup "$work/glib-build" "$work/sandbox-source/glib-2.90.1" --prefix="$work/qemu-deps" --libdir=lib --buildtype=release --wrap-mode=nofallback -Dtests=false -Dinstalled_tests=false -Dnls=disabled -Dintrospection=disabled -Dlibmount=disabled -Dselinux=disabled -Dxattr=false
meson compile -C "$work/glib-build" -j3
meson install -C "$work/glib-build"
source_archive libslirp-v4.9.5 https://gitlab.freedesktop.org/slirp/libslirp/-/archive/v4.9.5/libslirp-v4.9.5.tar.gz f43e68b60b580647574ec4a0e2b6c600a56281e6c39f79426510832dc810f483
meson setup "$work/slirp-build" "$work/sandbox-source/libslirp-v4.9.5" --prefix="$work/qemu-deps" --libdir=lib --buildtype=release --wrap-mode=nofallback
meson compile -C "$work/slirp-build" -j3
meson install -C "$work/slirp-build"
source_archive qemu-11.1.2 https://download.qemu.org/qemu-11.1.2.tar.xz 731b5681e4bb18be313231579b8efd0296c5b015fa36dc533874b639ba838016
# Keep the source path used by the packaging job and license collection.
ln -s "$work/sandbox-source/qemu-11.1.2" "$work/qemu-11.1.2"
cp "$root/scripts/sandbox/qemu-aarch64.mak" "$work/qemu-11.1.2/configs/devices/aarch64-softmmu/legalwork.mak"
cd "$work/qemu-11.1.2"
set -- --prefix="$work/qemu" --target-list="$arch-softmmu" --without-default-features --enable-tcg --enable-hvf --enable-slirp
if [ "$arch" = aarch64 ]; then set -- "$@" --without-default-devices --with-devices-aarch64=legalwork; fi
./configure "$@"
# The default target also compiles upstream test programs that this packaging
# job neither runs nor ships. Include all generated install prerequisites,
# including trace metadata and firmware, without building unrelated targets.
python3 "$root/scripts/sandbox/build-installed-qemu.py" "$PWD/build" "qemu-system-$arch"
meson install -C build --no-rebuild
