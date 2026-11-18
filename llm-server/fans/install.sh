#!/bin/bash
# Fan curve and Performance power profile for the Bosgame M5 (board AXB35-02, BIOS 3.11). Run as root.
#   sudo bash llm-server/fans/install.sh              build the patched ec_su_axb35 module, install and start
#   sudo bash llm-server/fans/install.sh uninstall    remove all of it; the firmware has the fans again
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VERSION=f62c2c2.m5duty3   # MODULE_VERSION in the patch
COMMIT=f62c2c228959a08683273a26ef3afd8991e69f6d
SOURCE=/usr/src/ec_su_axb35-$VERSION
EC=/sys/class/ec_su_axb35

die() { echo "install.sh: $*" >&2; exit 1; }
[[ $EUID == 0 ]] || die "run it with sudo"

if [[ ${1:-} == uninstall ]]; then
    systemctl disable --now m5-fans.service m5-power.service 2>/dev/null || true
    rm -f /usr/local/sbin/m5-fans.py /etc/systemd/system/m5-{fans,power}.service /etc/modules-load.d/ec_su_axb35.conf
    systemctl daemon-reload
    modprobe -r ec_su_axb35 2>/dev/null || true   # unloading releases both fans
    dkms remove "ec_su_axb35/$VERSION" --all 2>/dev/null || true
    rm -rf "$SOURCE"
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
[[ $(mokutil --sb-state 2>&1) != *enabled* ]] || die "Secure Boot is on, the module would not load: switch it off in the BIOS"

dnf install -y "kernel-devel-$(uname -r)" dkms gcc make elfutils-libelf-devel git
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$work" init -q
git -C "$work" fetch -q --depth=1 https://github.com/cmetz/ec-su_axb35-linux.git "$COMMIT"
git -C "$work" checkout -q FETCH_HEAD
git -C "$work" apply "$HERE/ec_su_axb35-m5duty3.patch"

systemctl stop m5-fans.service 2>/dev/null || true
modprobe -r ec_su_axb35 2>/dev/null || true
dkms remove "ec_su_axb35/$VERSION" --all 2>/dev/null || true
rm -rf "$SOURCE"
mkdir "$SOURCE"
cp -a "$work"/{src,Kbuild,Makefile} "$SOURCE/"
cat > "$SOURCE/dkms.conf" <<DKMS
PACKAGE_NAME=ec_su_axb35
PACKAGE_VERSION=$VERSION
MAKE[0]="make KERNEL_BUILD=\$kernel_source_dir"
BUILT_MODULE_NAME[0]=ec_su_axb35
DEST_MODULE_LOCATION[0]=/extra
AUTOINSTALL=yes
DKMS
dkms install "ec_su_axb35/$VERSION"
echo ec_su_axb35 > /etc/modules-load.d/ec_su_axb35.conf
modprobe ec_su_axb35

install -m 755 "$HERE/m5-fans.py" /usr/local/sbin/m5-fans.py
install -m 644 "$HERE"/m5-{fans,power}.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable m5-power.service m5-fans.service
systemctl restart m5-power.service m5-fans.service
sleep 3
systemctl is-active --quiet m5-fans.service || die "m5-fans.service did not stay up: journalctl -u m5-fans.service"
echo "install.sh: module $(<"/sys/module/ec_su_axb35/version"), profile $(<"$EC/apu/power_mode"), fan curve running"
