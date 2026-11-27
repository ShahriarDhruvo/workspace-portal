#!/bin/bash
# Usage: install.sh VERSION DEST
# Builds a complete LTX-2 install in DEST, which must not exist yet: the checkout of upstream tag vVERSION, a venv in
# DEST/.venv with AMD's PyTorch for gfx1151 and LTX-2's ltx-core and ltx-pipelines (built from the checkout, not
# editable), and the video job server (ltx-videos.py) at the checkout's root. The weights stay in /models/LTX-2.5.
# Writes nothing outside DEST but uv's cache and its managed Pythons. portal-hostd runs it for Admin > Updates.
set -eu -o pipefail

if [ $# -ne 2 ]; then
  echo "usage: install.sh VERSION DEST" >&2
  exit 2
fi
version=$1
dest=$2
here=$(dirname "$(readlink -f "$0")")
repo=https://github.com/Lightricks/LTX-2.git
# AMD's PyTorch with the ROCm libraries and kernels of gfx1151 alone, as ACE-Step's install uses. LTX-2 asks for
# torch ~= 2.7 with torchaudio and torchvision (Gemma 4's processor imports it).
torch_index=https://stable.repo.amd.com/rocm/whl-next/
torch_version=2.15.0+rocm10.2.0
torch="torch[device-gfx1151]==$torch_version"
torchaudio=torchaudio==2.11.1+rocm10.2.0
torchvision=torchvision==0.29.2+rocm10.2.0
# LTX-2 ships no lock file: these are the versions its v1.6.3 resolved to on 2026-11-27, held so a reinstall gets
# the same set. natten (the diffusion VAE's fast attention) is CUDA-only and not installed: LTX-2 uses its Triton one.
pins='accelerate==1.16.0
annotated-doc==0.0.7
annotated-types==0.8.0
anyio==4.16.0
av==19.0.2
certifi==2026.11.20
click==8.5.1
cloudpickle==3.1.3
colour-science==0.4.7
einops==0.8.2
filelock==4.0.8
fsspec==2026.9.0
h11==0.16.0
hf-xet==1.8.0
httpcore==1.0.9
httpx==0.29.0
huggingface-hub==1.33.0
idna==3.20
jinja2==3.1.6
markdown-it-py==4.3.0
markupsafe==3.0.3
mdurl==0.1.2
mpmath==1.3.0
networkx==3.7
numpy==2.5.3
openimageio==3.2.2.0
packaging==26.4
pillow==12.3.0
psutil==7.2.2
pydantic==2.14.4
pydantic-core==2.50.5
pygments==2.21.0
pyyaml==6.0.4
regex==2026.11.25
rich==15.0.0
safetensors==0.8.0
scipy==1.18.1
setuptools==81.0.0
shellingham==1.5.4
sympy==1.14.0
tokenizers==0.22.2
tqdm==4.70.1
transformers==5.14.1
typer==0.29.3
typing-extensions==4.16.0
typing-inspection==0.4.5'

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

echo "installing $torch, $torchaudio and $torchvision from $torch_index"
uv pip install -q --python "$py" --index-url "$torch_index" "$torch" "$torchaudio" "$torchvision"

echo "installing ltx-core and ltx-pipelines $version with that torch"
# --no-sources: their pyproject points torch at PyTorch's CUDA index.
uv pip install -q --python "$py" --no-sources "$dest/packages/ltx-core" "$dest/packages/ltx-pipelines" \
  --override <(printf '%s\n' "torch==$torch_version" "$torchaudio" "$torchvision") --constraint <(echo "$pins")

echo "copying the video job server"
cp "$here/ltx-videos.py" "$dest/ltx-videos.py"

echo "checking the imports (no GPU needed)"
cd "$dest"
"$py" -W ignore -c '
import av, torch, triton
assert torch.version.hip, f"torch {torch.__version__} is not a ROCm build"
for codec in ("libx264", "aac"):
    av.codec.Codec(codec, "w")
from ltx_pipelines.distilled import DistilledPipeline
print(f"torch {torch.__version__}, HIP {torch.version.hip}, triton {triton.__version__}; ltx_pipelines imports")
'
"$py" -W ignore ltx-videos.py --help > /dev/null
echo "installed LTX-2 $version ($(git -C "$dest" rev-parse --short HEAD)) in $dest"
