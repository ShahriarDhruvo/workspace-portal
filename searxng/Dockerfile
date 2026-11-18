# SearXNG with the portal's settings.yml inside: the container needs no volume, and a build pairs a release with
# the settings tested on it. To update, put a newer tag and its digest here (the tags are at
# https://github.com/searxng/searxng/pkgs/container/searxng; docker buildx imagetools inspect
# ghcr.io/searxng/searxng:<tag> prints the digest), run deploy/install.sh and deploy/verify-isolation.sh, and
# search once: SearXNG changes its engines from release to release.
FROM ghcr.io/searxng/searxng:2026.11.12-de722ab1b@sha256:0b104e2e1117b0ca83a36f3ac6ecda7d9ee948ccea6ead74750a03e1b856229a
# Not in /etc/searxng: upstream declares that a volume, whose copy would outlive the image and hide a newer file.
# The directory first: COPY would give one it creates the file's mode.
RUN mkdir -p -m 0755 /usr/local/etc/searxng
COPY --chmod=0444 settings.yml /usr/local/etc/searxng/settings.yml
ENV SEARXNG_SETTINGS_PATH=/usr/local/etc/searxng/settings.yml
# SearXNG's own user, which the upstream image leaves unnamed. docker-compose.yml runs it as the same.
USER 977:977
