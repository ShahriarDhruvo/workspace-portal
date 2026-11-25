# Sourced by the image's install scripts (toolchains.sh, a harness's install.sh): downloads that fail the build when
# they are not the file that was pinned. What they download is gone when the script ends.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# fetch <url> <SHA-256>: downloads it to $file.
fetch() {
  file=$work/${1##*/}
  curl -fsSL --retry 3 -o "$file" "$1"
  echo "$2  $file" | sha256sum --check --quiet -
}
# unpack <folder> <tar options...>: $file into the folder, owned by root.
unpack() {
  folder=$1
  shift
  mkdir -p "$folder"
  tar -C "$folder" --no-same-owner -xf "$file" "$@"
}
