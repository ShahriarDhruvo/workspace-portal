#!/bin/bash
# Fan curve and Performance power profile for the Bosgame M5 (board AXB35-02, BIOS 3.11). Run as root.
#   sudo bash llm-server/fans/install.sh              build the ec_su_axb35 module with DKMS and start the fan service
#   sudo bash llm-server/fans/install.sh uninstall    remove all of it; the firmware has the fans again
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/dkms.conf"
SOURCE=/usr/src/$PACKAGE_NAME-$PACKAGE_VERSION

die() { echo "install.sh: $*" >&2; exit 1; }
[[ $EUID == 0 ]] || die "run it with sudo"

remove() {   # every version of it; the daemon's exit and the module's unload both release the fans
    systemctl disable --now m5-fans.service 2>/dev/null || true
    [[ ! -d /sys/module/$PACKAGE_NAME ]] || rmmod "$PACKAGE_NAME"
    { dkms status "$PACKAGE_NAME" 2>/dev/null || true; } | sed -n "s|^\($PACKAGE_NAME/[^,:]*\).*|\1|p" | sort -u | xargs -r -n 1 dkms remove --all
    rm -rf /usr/src/"$PACKAGE_NAME"-* /usr/local/sbin/m5-fans.py /etc/systemd/system/m5-fans.service
    systemctl daemon-reload
}

if [[ ${1:-} == uninstall ]]; then
    remove
    echo "install.sh: removed; the firmware controls the fans"
    exit
fi
[[ $# == 0 ]] || die "unknown argument: $1"

# The module refuses any other machine too; this says so before the build.
while read -r field expected; do
    actual=$(<"/sys/class/dmi/id/$field")
    [[ $actual == "$expected" ]] || die "refusing: $field is '$actual', expected '$expected'"
done <<'DMI'
sys_vendor BOSGAME LIMITED
product_name BeyondMax Series
board_name AXB35-02
bios_version 3.11
DMI
[[ $(mokutil --sb-state 2>&1) == *disabled* ]] || die "Secure Boot is not off, the module would not load: switch it off in the BIOS"

dnf install -y "kernel-devel-$(uname -r)" dkms
remove
mkdir "$SOURCE"
cp "$HERE"/{ec_su_axb35.c,Kbuild,dkms.conf} "$SOURCE/"
dkms install "$PACKAGE_NAME/$PACKAGE_VERSION"
install -m 755 "$HERE/m5-fans.py" /usr/local/sbin/m5-fans.py
install -m 644 "$HERE/m5-fans.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now m5-fans.service
sleep 3
systemctl is-active --quiet m5-fans.service || die "m5-fans.service did not stay up: journalctl -u m5-fans.service"
echo "install.sh: module $PACKAGE_VERSION, profile $(</sys/class/ec_su_axb35/apu/power_mode), fan curve running"
