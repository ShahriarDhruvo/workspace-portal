#!/bin/sh
# Fails when a toolchain of the image (the Dockerfile's packages, toolchains.sh) does not build and run a program
# without a network. The build runs it. It works in the home folder, not in /tmp, where a workspace can run nothing
# (noexec), so that it says the same when run in a workspace.
set -eu
work=$(mktemp -d -p "$HOME")
trap 'rm -rf "$work"' EXIT
cd "$work"

# prints <word> <command...>: the command has to print the word.
prints() {
  word=$1
  shift
  [ "$("$@")" = "$word" ] || { echo "check-toolchains: \`$*\` did not print \"$word\"" >&2; exit 1; }
}

cat > hello.c <<'EOF'
#include <stdio.h>
int main(void) {
  puts("c");
  return 0;
}
EOF
gcc -O2 -Wall -o hello-c hello.c
prints c ./hello-c

# As a contest solution is built: every standard header at once, and the sanitizers that catch what a judge only
# calls a wrong answer.
cat > hello.cpp <<'EOF'
#include <bits/stdc++.h>
int main() {
  std::vector<std::string> words{"c++"};
  std::ranges::sort(words);
  std::cout << words.front() << "\n";
}
EOF
g++ -std=gnu++20 -O2 -Wall -fsanitize=address,undefined -o hello-cpp hello.cpp
prints c++ ./hello-cpp

cat > hello.go <<'EOF'
package main

import "fmt"

func main() {
	fmt.Println("go")
}
EOF
prints go go run hello.go
prints "" gofmt -l hello.go

mkdir -p rust/src
cat > rust/Cargo.toml <<'EOF'
[package]
name = "hello"
version = "0.0.0"
edition = "2024"
EOF
cat > rust/src/lib.rs <<'EOF'
/// The word the check waits for.
///
/// ```
/// assert_eq!(hello::word(), "rust");
/// ```
pub fn word() -> &'static str {
    "rust"
}
EOF
cat > rust/src/main.rs <<'EOF'
fn main() {
    println!("{}", hello::word());
}
EOF
prints rust cargo run --quiet --offline --manifest-path rust/Cargo.toml
# A doc test is built and run in the temporary folder: in a workspace, where entry.sh puts it.
cargo test --doc --quiet --offline --manifest-path rust/Cargo.toml > /dev/null || {
  echo "check-toolchains: a Rust doc test did not run" >&2
  exit 1
}
cargo fmt --check --manifest-path rust/Cargo.toml
cargo clippy --quiet --offline --manifest-path rust/Cargo.toml -- --deny warnings

cat > hello.py <<'EOF'
print("python")
EOF
prints python python3 hello.py
uv venv --quiet --offline venv
prints python venv/bin/python hello.py
ruff check --quiet --no-cache hello.py
ruff format --quiet --no-cache --check hello.py

cat > hello.sh <<'EOF'
#!/bin/bash
echo bash
EOF
prints bash bash hello.sh
shellcheck hello.sh
shfmt -d hello.sh

cat > hello.ps1 <<'EOF'
Write-Output ('power' + 'shell')
EOF
prints powershell pwsh -NoLogo -NoProfile -File hello.ps1

prints node node -e 'console.log("node")'

# The media tools: a second of tone and colour, encoded as the media skill's assembly does, then measured.
ffmpeg -v error -f lavfi -i testsrc=size=64x64:rate=24:duration=1 -f lavfi -i sine=frequency=440:duration=1 \
  -filter_complex "[1:a]asplit=2[a][k];[a][k]sidechaincompress,loudnorm=I=-14:TP=-1.5:LRA=11[m]" \
  -map 0:v -map "[m]" -c:v libx264 -pix_fmt yuv420p -c:a aac -ar 48000 -movflags +faststart media.mp4
[ "$(ffprobe -v error -show_entries stream=codec_name -of csv=p=0 media.mp4 | sort | tr '\n' ' ')" = "aac h264 " ] \
  || { echo "check-toolchains: ffmpeg did not make an H.264 and AAC file" >&2; exit 1; }
sox -n -r 16000 tone.wav synth 0.5 sine 440 && [ "$(soxi -D tone.wav)" = "0.500000" ] \
  || { echo "check-toolchains: sox did not make half a second of tone" >&2; exit 1; }
convert -size 8x8 xc:red red.png && [ "$(identify -format %wx%h red.png)" = "8x8" ] \
  || { echo "check-toolchains: ImageMagick did not make an image" >&2; exit 1; }

for tool in make gdb pnpm git rg jq curl ssh zip xz file ffmpeg ffprobe sox convert identify; do
  command -v "$tool" > /dev/null || { echo "check-toolchains: $tool is missing" >&2; exit 1; }
done
echo "check-toolchains: C, C++, Go, Rust, Python, Bash, PowerShell and Node build and run; ffmpeg, SoX and ImageMagick work"
