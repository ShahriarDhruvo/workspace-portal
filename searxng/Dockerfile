# The portal's search engine: SearXNG, with the portal's settings.yml inside the image, so the
# container needs no volume and one build pairs a SearXNG release with the settings tested on it.
#
# To update SearXNG: put a newer tag and its digest in the FROM line (the tags are listed at
# https://github.com/searxng/searxng/pkgs/container/searxng; `docker buildx imagetools inspect
# ghcr.io/searxng/searxng:<tag>` prints the digest), run `sudo bash deploy/install.sh` and then
# `sudo bash deploy/verify-isolation.sh`. SearXNG changes its engines from release to release, so
# check afterwards that a search still returns results.
FROM ghcr.io/searxng/searxng:2026.11.12-de722ab1b@sha256:0b104e2e1117b0ca83a36f3ac6ecda7d9ee948ccea6ead74750a03e1b856229a
# Not in /etc/searxng: the upstream image declares that directory a volume, so Docker would give the
# container a copy of it that outlives the image, and a later change of settings.yml would never
# arrive. docker-compose.yml puts an empty tmpfs there instead; SearXNG reads the file named here.
USER root
RUN mkdir -p -m 0755 /usr/local/etc/searxng
COPY --chmod=0444 settings.yml /usr/local/etc/searxng/settings.yml
ENV SEARXNG_SETTINGS_PATH=/usr/local/etc/searxng/settings.yml
# Back to the upstream image's own user. docker-compose.yml repeats it, and
# deploy/verify-isolation.sh checks it.
USER 977:977
