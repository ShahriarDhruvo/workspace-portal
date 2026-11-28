#!/bin/bash
# Usage: install.sh COMMIT DEST
# Builds a complete Ming-Image install in DEST, which must not exist yet: the checkout of upstream commit COMMIT (the
# repository has no releases), a venv in DEST/.venv with AMD's PyTorch for gfx1151 and Ming-Image's dependencies, and
# the adapter (ming-images.py) at the checkout's root, where it imports Ming-Image from the source tree. The weights
# stay in /models/Ming-Image-0.2-Design. Writes nothing outside DEST but uv's cache and its managed Pythons.
set -eu -o pipefail

commit=$1
dest=$2
here=$(dirname "$(readlink -f "$0")")
repo=https://github.com/inclusionAI/Ming-Image.git
# AMD's PyTorch with the ROCm libraries and kernels of gfx1151 alone, as ACE-Step and LTX-2 use it. Ming uses
# torchvision for PIL transforms on the CPU alone.
torch_index=https://stable.repo.amd.com/rocm/whl-next/
torch_version=2.15.0+rocm10.2.0
torch="torch[device-gfx1151]==$torch_version"
torchvision=torchvision==0.29.2+rocm10.2.0

set -a
. /etc/ai-studio/cache.env
set +a

if [ -e "$dest" ]; then
  echo "install.sh: $dest already exists" >&2
  exit 1
fi
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "install.sh: give the full 40-character commit" >&2; exit 1; }

echo "fetching $repo at $commit"
git init -q "$dest"
git -C "$dest" fetch -q --depth 1 "$repo" "$commit"
git -C "$dest" -c advice.detachedHead=false checkout -q FETCH_HEAD

echo "creating the venv with Python 3.12"
uv python install -q 3.12
# Relocatable, as DEST is renamed once the install is complete.
uv venv -q --relocatable --python 3.12 "$dest/.venv"
py=$dest/.venv/bin/python

echo "installing $torch and $torchvision from $torch_index"
uv pip install -q --python "$py" --index-url "$torch_index" "$torch" "$torchvision"

echo "installing Ming-Image's dependencies from its requirements.txt, with that torch"
# The file pins CUDA's torch 2.4 and NVIDIA's Transformer Engine, which the code only imports when it is there (its
# RMSNorm falls back to a native one), and numpy 1.23, which has no build for Python 3.12. Attention is eager.
uv pip install -q --python "$py" -r <(grep -vE '^(torch|torchvision|transformer-engine|numpy)[=\[]' "$dest/requirements.txt") \
  'numpy>=1.26,<2.4' --override <(printf '%s\n' "torch==$torch_version" "$torchvision")

echo "copying the adapter"
cp "$here/ming-images.py" "$dest/ming-images.py"

echo "checking the imports (no GPU needed)"
cd "$dest"
"$py" -c '
import importlib.util, torch
assert torch.version.hip, f"torch {torch.__version__} is not a ROCm build"
import infer, diffusion.pipeline  # Ming-Image itself
spec = importlib.util.spec_from_file_location("ming_images", "ming-images.py")
spec.loader.exec_module(importlib.util.module_from_spec(spec))
print(f"torch {torch.__version__}, HIP {torch.version.hip}; Ming-Image and the adapter import")
'
echo "installed Ming-Image $(git -C "$dest" rev-parse --short HEAD) in $dest"
