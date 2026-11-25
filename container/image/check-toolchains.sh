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
cat > rust/src/main.rs <<'EOF'
fn main() {
    println!("rust");
}
EOF
prints rust cargo run --quiet --offline --manifest-path rust/Cargo.toml
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
for tool in make gdb pnpm ssh zip xz file; do
  command -v "$tool" > /dev/null || { echo "check-toolchains: $tool is missing" >&2; exit 1; }
done
echo "check-toolchains: C, C++, Go, Rust, Python, Bash, PowerShell and Node build and run"
