#!/bin/bash
# Downloads Qwen3.8-Flash-Next (UD-Q4_K_XL), its MTP helper and the vision file to /models/qwen3.8-flash-next:
# six files, 115 GB, three at a time. Run it again after an interruption: a partial file resumes, a finished
# one is only verified. A file gets its final name only after its SHA256 matched.
set -euo pipefail

mkdir -p /models/qwen3.8-flash-next/UD-Q4_K_XL /models/qwen3.8-flash-next/MTP
cd /models/qwen3.8-flash-next
export BASE=https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF/resolve/38bb39ee97821de2c9009abb7e93950eec396e66

verified() { echo "$1  $2" | sha256sum --check --status 2>/dev/null; }
fetch() {  # fetch SHA256 FILE
    if verified "$1" "$2"; then echo "SHA256 verified: $2"; return; fi
    if [[ -e $2 ]]; then echo "Existing file failed verification, look at it before replacing: $2" >&2; return 1; fi
    if ! verified "$1" "$2.part"; then
        curl --fail --location --retry 8 --retry-all-errors --retry-delay 5 --connect-timeout 30 \
            --speed-limit 1024 --speed-time 120 --continue-at - --output "$2.part" "$BASE/$2"
        verified "$1" "$2.part" || { echo "Downloaded file failed verification: $2.part" >&2; return 1; }
    fi
    mv -- "$2.part" "$2" && echo "SHA256 verified: $2"
}
export -f verified fetch

xargs -n 2 -P 3 bash -c 'fetch "$@"' _ <<'FILES'
4448186216b3af4cc558bbce2c3213f01608f8f8b2e5267a9767971dd3ec8082 UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf
3f342f1c1580473f1ee94ddd5b28206e8c07a70fa1a366f59d1d6c922919a6c9 UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00004.gguf
56758f40269cad5cd9b0d3d6fbae0f40f6d5be6de49e4ab392dbe83157d9cbd3 UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00003-of-00004.gguf
753bda48b98ba4f1636134a90a967de1b2d3908a236c026e464777342e53510a UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00004-of-00004.gguf
5ff54097406a905cf3a724c709124ceb0e3e10235ee862298969e91c96fa96e6 MTP/mtp-Qwen3.8-Flash-Next-shared-Q8_0.gguf
2e788f8c511d8093c7b43cb87b2fd7e14228340318057f8fb20c86df2efe2355 mmproj-BF16.gguf
FILES
echo "Ready: $PWD"
