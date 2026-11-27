#!/bin/bash
# Usage: install.sh VERSION DEST
# Builds a complete ACE-Step 1.5 install in DEST, which must not exist yet: the checkout of upstream tag vVERSION, a
# venv in DEST/.venv with AMD's PyTorch for gfx1151 and ACE-Step's dependencies, and the adapter (acestep-sync.py) at
# the checkout's root, where it imports ACE-Step from the source tree. The weights stay in /models/ACE-Step-1.5.
# Writes nothing outside DEST but uv's cache and its managed Pythons. portal-hostd runs it for Admin > Updates.
set -eu -o pipefail

version=$1
dest=$2
here=$(dirname "$(readlink -f "$0")")
repo=https://github.com/ace-step/ACE-Step-1.5.git
# AMD's PyTorch with the ROCm libraries and kernels of gfx1151 alone; torchaudio 2.11 is its newest for torch 2.15.
torch_index=https://stable.repo.amd.com/rocm/whl-next/
torch_version=2.15.0+rocm10.2.0
torch="torch[device-gfx1151]==$torch_version"
torchaudio=torchaudio==2.11.1+rocm10.2.0

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
# ACE-Step needs Python >= 3.11, < 3.13; Fedora's is newer.
uv python install -q 3.12
# Relocatable, as DEST is renamed once the install is complete.
uv venv -q --relocatable --python 3.12 "$dest/.venv"
py=$dest/.venv/bin/python

echo "installing $torch and $torchaudio from $torch_index"
uv pip install -q --python "$py" --index-url "$torch_index" "$torch" "$torchaudio"

echo "installing ACE-Step's dependencies from its pyproject.toml, with that torch"
# pyproject pins CUDA builds of torch, torchvision and torchaudio. ACE-Step itself is not installed: it runs from the
# checkout. Its setuptools<72 is only for pkg_resources (pytorch_wavelets, DCW), which setuptools keeps up to 80;
# torch 2.15 needs >= 77.0.3. Not installed: torchvision (unused), torchcodec (built for other torch versions; audio
# goes through soundfile and ffmpeg) and nano-vllm (the 5Hz LM's backend; the adapter uses the DiT alone).
uv pip install -q --python "$py" --no-sources -r "$dest/pyproject.toml" \
  --override <(printf '%s\n' "torch==$torch_version" "$torchaudio" 'setuptools>=77.0.3,<81') \
  --excludes <(printf '%s\n' torchvision torchcodec nano-vllm)

echo "copying the adapter"
cp "$here/acestep-sync.py" "$dest/acestep-sync.py"

echo "checking the imports (no GPU needed)"
cd "$dest"
"$py" -c '
import importlib.util, torch
from pytorch_wavelets import DWT1DForward  # DCW turns itself off without it
assert torch.version.hip, f"torch {torch.__version__} is not a ROCm build"
spec = importlib.util.spec_from_file_location("acestep_sync", "acestep-sync.py")
spec.loader.exec_module(importlib.util.module_from_spec(spec))
print(f"torch {torch.__version__}, HIP {torch.version.hip}; ACE-Step and the adapter import")
'
echo "installed ACE-Step $version ($(git -C "$dest" rev-parse --short HEAD)) in $dest"
