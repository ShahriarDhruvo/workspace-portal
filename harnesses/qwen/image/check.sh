#!/bin/sh
# What the portal changes of Qwen Code is checked where it is made (trim-web-shell.mjs, at install); here only that
# it runs with no network and no home but /tmp, as the version checks run it.
set -eu
HOME=/tmp qwen --version
