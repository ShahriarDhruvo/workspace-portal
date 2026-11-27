# The media servers' cache locations (/etc/ai-studio/cache.env) for login shells, so a command run by hand finds what
# the servers compiled and downloaded. Goes to /etc/profile.d/.
if [ -r /etc/ai-studio/cache.env ]; then
  set -a
  . /etc/ai-studio/cache.env
  set +a
fi
