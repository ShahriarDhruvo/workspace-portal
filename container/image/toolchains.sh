#!/bin/sh
# The compilers and tools a workspace has beside Debian's own (the Dockerfile's packages), whichever harness it runs:
# a Private workspace can download nothing, so what the work needs is in the image. Each is its maker's release for
# this machine, at the version here, and refused when its SHA-256 is not the one written beside it (amd64's, then
# arm64's). check-toolchains.sh proves they work without a network.
set -eu
. /usr/local/lib/workspace-portal/fetch.sh

GO=1.27.4
RUST=1.100.1
UV=0.13.10
RUFF=0.17.6
POWERSHELL=7.7.0
SHELLCHECK=0.11.0
SHFMT=3.14.1

case "$(dpkg --print-architecture)" in
  amd64) go=amd64 rust=x86_64-unknown-linux-gnu shellcheck=x86_64 dotnet=x64 ;;
  arm64) go=arm64 rust=aarch64-unknown-linux-gnu shellcheck=aarch64 dotnet=arm64 ;;
  *) echo "toolchains: nothing is pinned for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac
# fetch_for <url> <amd64's SHA-256> <arm64's>
fetch_for() {
  if [ "$go" = amd64 ]; then fetch "$1" "$2"; else fetch "$1" "$3"; fi
}

fetch_for "https://go.dev/dl/go$GO.linux-$go.tar.gz" \
  7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840 3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92
unpack /usr/local
ln -s /usr/local/go/bin/go /usr/local/go/bin/gofmt /usr/local/bin/

# Rust's own installer, for the compiler, cargo, the standard library, rustfmt and clippy: no rustup, so nothing
# here looks for another toolchain. Its documentation is not unpacked.
fetch_for "https://static.rust-lang.org/dist/rust-$RUST-$rust.tar.xz" \
  cf0d1dc00dbccc0bc63ec0bdb3da8bafe3e969cb3fbfa36dc5e6205467a50fea 480fe52727ce7372f0b2597c24e462bb3f25d1dc534a05c3e003cf7254e69153
unpack "$work" --exclude='*/rust-docs*'
"$work/rust-$RUST-$rust/install.sh" --prefix=/usr/local --disable-ldconfig \
  --components="rustc,cargo,rust-std-$rust,rustfmt-preview,clippy-preview"

fetch_for "https://github.com/astral-sh/uv/releases/download/$UV/uv-$rust.tar.gz" \
  bf65ac1a0af10f92c522d91ac096c7c0a39657647b155577e7836c2cbbb4526c 14590f644805a6234ffe071154340669e38137f38e60aa9629690119704107d2
unpack /usr/local/bin --strip-components=1

fetch_for "https://github.com/astral-sh/ruff/releases/download/$RUFF/ruff-$rust.tar.gz" \
  94b33791f48cd54ab35ad673a443a5c001d3e6d87effeaba9899070b700d45f3 d4eea36ee6228f6c6bbcf0aea4ebf66fe0e595eedc6cffe628d7b8ba3623390f
unpack /usr/local/bin --strip-components=1

# Its archive holds pwsh without the right to run it.
fetch_for "https://github.com/PowerShell/PowerShell/releases/download/v$POWERSHELL/powershell-$POWERSHELL-linux-$dotnet.tar.gz" \
  c89d9c682d2c403dfe726f3df948e359675235a5bd6fab535776de69729ca0cb e59c89776eaa59790d44b3edd14277435225ab08b6e7603763101b89de83d935
unpack /opt/microsoft/powershell/7
chmod 0755 /opt/microsoft/powershell/7/pwsh
ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh

fetch_for "https://github.com/koalaman/shellcheck/releases/download/v$SHELLCHECK/shellcheck-v$SHELLCHECK.linux.$shellcheck.tar.xz" \
  8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198 12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588
unpack /usr/local/bin --strip-components=1 "shellcheck-v$SHELLCHECK/shellcheck"

fetch_for "https://github.com/mvdan/sh/releases/download/v$SHFMT/shfmt_v${SHFMT}_linux_$go" \
  76e77641faa025814b77f153b29796b8e6fa2fca03e0c76a691608b86c7ea7bf 5f2db09dae91fca848f7adbdd014632e921a383863a2ad7e0450ad3aba0c6489
install -m 0755 "$file" /usr/local/bin/shfmt
