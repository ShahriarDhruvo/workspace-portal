#!/bin/bash
# Usage: install.sh VERSION DEST
# Builds a complete Fish Speech install in DEST, which must not exist yet: the checkout of upstream tag vVERSION, a
# venv in DEST/.venv with PyTorch for ROCm and fish-speech's dependencies, and the OpenAI-style adapter next to them.
# Writes nothing outside DEST but uv's cache and its managed Pythons. portal-hostd runs it for Admin > Updates.
set -eu -o pipefail

if [ $# -ne 2 ]; then
  echo "usage: install.sh VERSION DEST" >&2
  exit 2
fi
version=$1
dest=$2
here=$(dirname "$(readlink -f "$0")")
repo=https://github.com/fishaudio/fish-speech.git
# PyTorch's stable ROCm build, which has gfx1151 kernels; torchaudio 2.11 is its newest release and needs torch >= 2.11.
torch_index=https://download.pytorch.org/whl/rocm10.0
torch=torch==2.15.0+rocm10.0
torchaudio=torchaudio==2.11.1+rocm10.0
# torch asks for the kernels of every GPU (rocm[device-all]; gfx942's alone are 1.6 GB); this machine needs gfx1151's.
rocm='rocm[libraries,device-gfx1151]==10.0.0'
# torchaudio >= 2.9 reads audio (the voice to clone) through torchcodec, which uses the system's FFmpeg libraries.
# PyPI's torchcodec needs CUDA (libnvrtc); this is its CPU build.
torchcodec_index=https://download.pytorch.org/whl/cpu
torchcodec=torchcodec==0.17.0+cpu

set -a
. /etc/ai-studio/cache.env
set +a

if [ -e "$dest" ]; then
  echo "install.sh: $dest already exists" >&2
  exit 1
fi

echo "cloning $repo at v$version"
git clone -q --depth 1 --branch "v$version" -c advice.detachedHead=false "$repo" "$dest"

echo "creating the venv with Python 3.12"
uv python install -q 3.12
# Relocatable, as DEST is renamed once the install is complete.
uv venv -q --relocatable --python 3.12 "$dest/.venv"
py=$dest/.venv/bin/python

echo "installing $torch and $torchaudio from $torch_index"
uv pip install -q --python "$py" --index-url "$torch_index" --override <(echo "$rocm") "$torch" "$torchaudio"

echo "installing fish-speech's dependencies, at the versions of its uv.lock"
# pyproject pins the CUDA/CPU torch 2.8, so its dependencies go in without torch (pyaudio is for its command-line
# client only), held to uv.lock's versions where torch has not brought its own: newer ones break (tensorboard 2.21
# was built for protobuf 6.31, which fish-speech's override forbids).
"$py" - "$dest" <<'EOF'
import re, sys, tomllib
from importlib.metadata import distributions
from pathlib import Path


def name(requirement: str) -> str:
    return re.sub(r"[-_.]+", "-", re.split(r"[\s\[<>=!~;]", requirement, maxsplit=1)[0]).lower()


dest = Path(sys.argv[1])
project = tomllib.loads((dest / "pyproject.toml").read_text())
lock = tomllib.loads((dest / "uv.lock").read_text())["package"]
installed = {name(d.metadata["Name"]) for d in distributions()}
deps = [d for d in project["project"]["dependencies"] if name(d) not in {"torch", "torchaudio", "pyaudio"}]
versions: dict[str, set[str]] = {}
for package in lock:
    if "version" in package and "editable" not in package["source"] and "virtual" not in package["source"]:
        versions.setdefault(package["name"], set()).add(package["version"])
pins = [f"{n}=={v.pop()}" for n, v in sorted(versions.items()) if len(v) == 1 and n not in installed]
overrides = project.get("tool", {}).get("uv", {}).get("override-dependencies", [])
for file, lines in (("requirements", deps), ("constraints", pins), ("overrides", overrides)):
    (dest / f".venv/fish-{file}.txt").write_text("".join(f"{line}\n" for line in lines))
EOF
# uv resolves the installed torch's requirements again, so the rocm override is needed here too.
uv pip install -q --python "$py" --constraint <(printf '%s\n' "$torch" "$torchaudio") \
  --constraint "$dest/.venv/fish-constraints.txt" --override <(echo "$rocm") \
  --override "$dest/.venv/fish-overrides.txt" -r "$dest/.venv/fish-requirements.txt"

echo "installing $torchcodec from $torchcodec_index"
uv pip install -q --python "$py" --no-deps --index-url "$torchcodec_index" "$torchcodec"

echo "copying the adapter"
cp "$here/fish-speech-openai.py" "$dest/"

echo "checking the imports (no GPU needed)"
cd "$dest"
"$py" -c 'import torch, torchaudio, torchcodec, fish_speech
print(f"torch {torch.__version__}, HIP {torch.version.hip}, torchaudio {torchaudio.__version__}, torchcodec {torchcodec.__version__}")
assert torch.version.hip, "this torch has no ROCm"'
"$py" fish-speech-openai.py --help > /dev/null
echo "installed fish-speech $version in $dest"
