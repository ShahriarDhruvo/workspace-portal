"""Tests for portal-hostd. Run from the repo root:  python3 -m unittest hostd/test_hostd.py
No root, no network (only 127.0.0.1), fake /proc and /sys trees, fake podman/systemctl runner."""

import http.client
import http.server
import importlib.util
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('portal_hostd', os.path.join(HERE, 'portal-hostd.py'))
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)

TOKEN = 'a' * 40
REPO = 'ghcr.io/gufo-org/toolboxes/gufo-runtime'
D_OLD = 'sha256:' + '9a' * 32
D_NEW = 'sha256:' + 'b1' * 32
D_BAD = 'sha256:' + 'cc' * 32
D_THIRD = 'sha256:' + 'dd' * 32


def write(root, path, data, mode='w'):
    full = root + path
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, mode) as f:
        f.write(data)


def gpu_metrics_blob(gfx_temp=4950, activity=0, socket_mw=7577, gfx_mw=38, core_mw=490, gfxclk=602,
                     throttle=(0, 10, 0, 0, 0, 0, 0), fmt=3, content=0):
    b = bytearray(264)
    struct.pack_into('<HBB', b, 0, 264, fmt, content)
    for off, kind, *values in ((4, '<H', gfx_temp), (42, '<H', activity), (112, '<I', socket_mw), (124, '<I', gfx_mw),
                               (132, '<I', core_mw), (174, '<H', gfxclk), (224, '<H', 2900), (228, '<7I', *throttle)):
        struct.pack_into(kind, b, off, *values)
    return bytes(b)


def proc_stat(per):
    """per: list of (busy, idle) jiffies per cpu."""
    lines = []
    tb = sum(p[0] for p in per)
    ti = sum(p[1] for p in per)
    lines.append(f'cpu  {tb} 0 0 {ti} 0 0 0 0 0 0')
    for i, (b, idl) in enumerate(per):
        lines.append(f'cpu{i} {b} 0 0 {idl} 0 0 0 0 0 0')
    lines.append('intr 1 2 3')
    return '\n'.join(lines) + '\n'


MEMINFO = """MemTotal:       130479124 kB
MemFree:         1330196 kB
MemAvailable:    6103420 kB
SwapTotal:       8388604 kB
SwapFree:        8388376 kB
GPUActive:      116784360 kB
GPUReclaim:            0 kB
"""

PCI_IDS = """# test pci.ids
1002  Advanced Micro Devices, Inc. [AMD/ATI]
\t1586  Strix Halo [Radeon Graphics / Radeon 8050S Graphics / Radeon 8060S Graphics]
\t\t1002 0001  Some subsystem
\t15bf  Phoenix1 [Radeon 740M / 760M / 780M Graphics]
8086  Intel Corporation
\t1902  Skylake-S GT1 [HD Graphics 510]
C 00  Unclassified device
"""


def cpuinfo(model, ncpu, siblings=2):
    out = []
    for i in range(ncpu):
        out.append(f'processor\t: {i}\nmodel name\t: {model}\nphysical id\t: 0\ncore id\t\t: {i % (ncpu // siblings)}\n')
    return '\n'.join(out) + '\n'


def make_amd(root, ncpu=4):
    write(root, '/proc/stat', proc_stat([(100, 1000)] * ncpu))
    write(root, '/proc/meminfo', MEMINFO)
    write(root, '/proc/cpuinfo', cpuinfo('AMD RYZEN AI MAX+ 395 w/ Radeon 8060S', ncpu))
    write(root, '/proc/sys/kernel/osrelease', '7.2.15-200.fc44.x86_64\n')
    write(root, '/etc/os-release', 'NAME="Fedora Linux"\nPRETTY_NAME="Fedora Linux 44 (Server Edition)"\n')
    for i in range(ncpu):
        write(root, f'/sys/devices/system/cpu/cpu{i}/cpufreq/scaling_cur_freq', '2000000\n')
        write(root, f'/sys/devices/system/cpu/cpu{i}/cpufreq/cpuinfo_max_freq', '5187500\n')
    write(root, '/sys/class/hwmon/hwmon3/name', 'k10temp\n')
    write(root, '/sys/class/hwmon/hwmon3/temp1_input', '48250\n')
    write(root, '/sys/class/hwmon/hwmon2/name', 'amdgpu\n')
    dev = '/sys/class/drm/card1/device'
    write(root, dev + '/gpu_metrics', gpu_metrics_blob(), 'wb')
    write(root, dev + '/mem_info_vram_used', '192184320\n')
    write(root, dev + '/mem_info_vram_total', '1073741824\n')
    write(root, dev + '/vendor', '0x1002\n')
    write(root, dev + '/device', '0x1586\n')
    os.makedirs(root + '/sys/bus/pci/drivers/amdgpu', exist_ok=True)
    os.symlink(root + '/sys/bus/pci/drivers/amdgpu', root + dev + '/driver')
    os.makedirs(root + '/sys/class/drm/card1-DP-1', exist_ok=True)
    write(root, '/sys/class/ec_su_axb35/fan1/rpm', '1200\n')
    write(root, '/sys/class/ec_su_axb35/fan1/duty', '40\n')
    write(root, '/sys/class/ec_su_axb35/fan2/rpm', '1300\n')
    write(root, '/sys/class/ec_su_axb35/fan2/duty', '40\n')
    write(root, '/sys/class/ec_su_axb35/fan3/rpm', '0\n')
    write(root, '/usr/share/hwdata/pci.ids', PCI_IDS)


def make_intel(root, ncpu=2):
    write(root, '/proc/stat', proc_stat([(100, 1000)] * ncpu))
    write(root, '/proc/meminfo', 'MemTotal: 8006484 kB\nMemAvailable: 6256616 kB\nSwapTotal: 8005628 kB\n'
                                 'SwapFree: 7961900 kB\nGPUActive: 0 kB\n')
    write(root, '/proc/cpuinfo', cpuinfo('Intel(R) Pentium(R) CPU G4400T @ 2.90GHz', ncpu, 1))
    write(root, '/proc/sys/kernel/osrelease', '7.2.11-300.fc45.x86_64\n')
    write(root, '/etc/os-release', 'PRETTY_NAME="Fedora Linux 45 (Server Edition)"\n')
    for i in range(ncpu):
        write(root, f'/sys/devices/system/cpu/cpu{i}/cpufreq/scaling_cur_freq', '800000\n')
        write(root, f'/sys/devices/system/cpu/cpu{i}/cpufreq/cpuinfo_max_freq', '2900000\n')
    h = '/sys/class/hwmon/hwmon1'
    write(root, h + '/name', 'coretemp\n')
    write(root, h + '/temp1_label', 'Package id 0\n')
    write(root, h + '/temp1_input', '31000\n')
    write(root, h + '/temp2_label', 'Core 0\n')
    write(root, h + '/temp2_input', '30000\n')
    c = '/sys/class/drm/card0'
    write(root, c + '/gt_act_freq_mhz', '0\n')
    write(root, c + '/gt_RP0_freq_mhz', '950\n')
    write(root, c + '/power/rc6_residency_ms', '1000\n')
    write(root, c + '/device/vendor', '0x8086\n')
    write(root, c + '/device/device', '0x1902\n')
    os.makedirs(root + '/sys/bus/pci/drivers/i915', exist_ok=True)
    os.symlink(root + '/sys/bus/pci/drivers/i915', root + c + '/device/driver')
    write(root, '/usr/share/hwdata/pci.ids', PCI_IDS)


def net_dev(counters):
    """/proc/net/dev with counters: {name: (rx_bytes, tx_bytes)}."""
    head = ('Inter-|   Receive                                                |  Transmit\n'
            ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n')
    return head + ''.join(f'{n:>6}: {rx} 10 0 0 0 0 0 0 {tx} 10 0 0 0 0 0 0\n' for n, (rx, tx) in counters.items())


def disk_stats(counters):
    """/proc/diskstats with counters: {name: (sectors_read, sectors_written)}."""
    return ''.join(f' 259 {i} {n} 100 0 {r} 50 200 0 {w} 70 0 90 120 0 0 0 0\n' for i, (n, (r, w)) in enumerate(counters.items()))


# As a hardened portal-hostd sees them: btrfs / with its /home subvolume, a separate /srv/data partition, a loop
# mount, PrivateDevices' /dev and PrivateTmp's bind mount, and a separate /home2 partition that ProtectHome-like
# overmounting hides behind an empty tmpfs.
MOUNTS = """/dev/dm-0 / btrfs rw,relatime,subvolid=256,subvol=/root 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
/dev/dm-0 /home btrfs rw,relatime,subvolid=257,subvol=/home 0 0
/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0
/dev/sda1 /srv/my\\040data xfs rw,relatime 0 0
/dev/sdb1 /home2 ext4 rw,relatime 0 0
/dev/sdb2 /home2/inner ext4 rw,relatime 0 0
/dev/loop0 /var/lib/snapd/snap/core squashfs ro 0 0
/dev/zram1 /var/compressed ext4 rw 0 0
tmpfs /dev tmpfs ro,nosuid,noexec,mode=755 0 0
/dev/dm-0 /var/tmp btrfs rw,relatime,subvolid=256,subvol=/root/var/tmp 0 0
tmpfs /home2 tmpfs ro,nosuid,nodev,noexec,mode=700 0 0
"""
SPACE = {'/': (1000, 400), '/boot/efi': (10, 5), '/srv/my data': (500, 100), '/home2': (7, 7), '/home': (3, 3)}


def fake_statvfs(root):
    """statvfs over the fixture: SPACE[mount point] = (blocks, available blocks) of 4096 bytes."""
    def statvfs(path):
        point = path[len(root):] or '/'
        if point not in SPACE:
            raise FileNotFoundError(path)
        blocks, avail = SPACE[point]
        return os.statvfs_result((4096, 4096, blocks, avail + 1, avail, 0, 0, 0, 0, 255))
    return statvfs


def make_net_disk(root, net=None):
    write(root, '/proc/net/dev', net_dev(net or {'lo': (5000, 5000), 'docker0': (900, 900), 'veth1a2b': (800, 800),
                                                 'enp1s0': (10_000, 2_000), 'wlan0': (100, 50), 'wg0': (70, 70)}))
    for name in ('lo', 'docker0', 'veth1a2b', 'wg0'):
        os.makedirs(root + f'/sys/class/net/{name}', exist_ok=True)
    for name in ('enp1s0', 'wlan0'):
        os.makedirs(root + f'/sys/class/net/{name}/device', exist_ok=True)
    write(root, '/proc/diskstats', disk_stats({'nvme0n1': (1000, 2000), 'nvme0n1p1': (900, 1900), 'dm-0': (800, 1800),
                                               'loop0': (5, 0), 'zram0': (7, 7), 'sda': (10, 20)}))
    for name in ('dm-0', 'loop0', 'zram0'):
        os.makedirs(root + f'/sys/block/{name}', exist_ok=True)
    for name in ('nvme0n1', 'sda'):
        os.makedirs(root + f'/sys/block/{name}/device', exist_ok=True)
    write(root, '/proc/self/mounts', MOUNTS)


class TmpRoot(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix='hostd-test-')

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)


class FakeGroup:
    """Stands in for a PerfGroup: read() returns the counts the test sets (cumulative since open, like perf)."""

    counts = None

    def __init__(self, labels, factors):
        self.labels, self.factors = labels, factors
        self.opened = 0
        self.closed = 0
        self.fds = []

    def open(self):
        self.opened += 1
        self.fds = [1]
        return True

    def close(self):
        self.closed += 1
        self.fds = []

    def read(self):
        return (1, 1, list(self.counts)) if self.fds and self.counts is not None else None


class TestDecode(unittest.TestCase):
    def test_gpu_metrics_v3(self):
        gm = H.decode_gpu_metrics(gpu_metrics_blob(activity=97, socket_mw=156200))
        self.assertEqual(gm['temperature_gfx'], 4950)
        self.assertEqual(gm['average_gfx_activity'], 97)
        self.assertEqual(gm['average_socket_power'], 156200)
        self.assertEqual(gm['current_gfx_maxfreq'], 2900)
        self.assertEqual(gm['throttle'], (0, 10, 0, 0, 0, 0, 0))

    def test_other_revision_rejected(self):
        self.assertIsNone(H.decode_gpu_metrics(gpu_metrics_blob(fmt=2, content=4)))
        self.assertIsNone(H.decode_gpu_metrics(b'\x08\x01\x03\x00'))

    def test_invalid_markers_are_none(self):
        gm = H.decode_gpu_metrics(gpu_metrics_blob(gfx_temp=0xFFFF, socket_mw=0xFFFFFFFF))
        self.assertIsNone(gm['temperature_gfx'])
        self.assertIsNone(gm['average_socket_power'])


class TestPerfEncoding(TmpRoot):
    def test_amd_df_configs_match_validated_values(self):
        base = '/sys/bus/event_source/devices/amd_df'
        write(self.root, base + '/type', '12\n')
        write(self.root, base + '/cpumask', '0\n')
        write(self.root, base + '/format/event', 'config:0-7,32-37\n')
        write(self.root, base + '/format/umask', 'config:8-15,24-27\n')
        fs = H.Fs(self.root)
        enc = lambda n, um: H.pmu_encode(fs, 'amd_df', f'event={0x1f + 0x40 * n},umask={um}')['config']
        self.assertEqual(enc(0, 0xffe), 0x00000f00fe1f)
        self.assertEqual(enc(0, 0x7ff), 0x00000700ff1f)
        self.assertEqual(enc(4, 0xffe), 0x00010f00fe1f)
        self.assertEqual(enc(12, 0x7ff), 0x00030700ff1f)
        g = H.PerfGroup(fs, 'amd_df', [('rd0', 'event=0x1f,umask=0xffe', 256.0)])
        self.assertEqual((g.type, g.cpu), (12, 0))

    def test_named_event_and_scale(self):
        base = '/sys/bus/event_source/devices/power'
        write(self.root, base + '/format/event', 'config:0-7\n')
        write(self.root, base + '/events/energy-pkg', 'event=0x02\n')
        write(self.root, base + '/events/energy-pkg.scale', '2.3283064365386962890625e-10\n')
        fs = H.Fs(self.root)
        spec, scale = H.pmu_event(fs, 'power', 'energy-pkg')
        self.assertEqual(H.pmu_encode(fs, 'power', spec)['config'], 2)
        self.assertAlmostEqual(scale, 2 ** -32)
        self.assertEqual(H.pmu_encode(fs, 'i915', 'config=0x100003')['config'], 0x100003)

    def test_missing_pmu(self):
        with self.assertRaises(H.PerfUnavailable):
            H.PerfGroup(H.Fs(self.root), 'amd_df', [('x', 'event=1', 1.0)])

    def test_rates_and_multiplex_correction(self):
        g = FakeGroup(['rd', 'wr'], [64.0, 64.0])
        prev = (1000, 1000, [0, 0])
        cur = (3000, 2000, [100, 50])  # ran half of the enabled time -> x2
        self.assertEqual(H.perf_rates(g, prev, cur, 0.5), [100 * 2 * 64 / 0.5, 50 * 2 * 64 / 0.5])
        self.assertIsNone(H.perf_rates(g, None, cur, 0.5))
        self.assertIsNone(H.perf_rates(g, (5, 5, [0, 0]), (6, 5, [1, 1]), 0.5))  # never running


class TestHostAmd(TmpRoot):
    def setUp(self):
        super().setUp()
        make_amd(self.root)
        self.host = H.Host(H.Fs(self.root), 'llm', 500, 'gufo.service')

    def test_info(self):
        info = self.host.info()
        self.assertEqual(info['role'], 'llm')
        self.assertEqual(info['os'], 'Fedora Linux 44 (Server Edition)')
        self.assertEqual(info['kernel'], '7.2.15-200.fc44.x86_64')
        self.assertEqual(info['cpu'], {'model': 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S', 'cores': 2, 'threads': 4,
                                       'maxMhz': 5187})
        self.assertEqual(info['gpu'], {'name': 'Radeon 8060S', 'maxMhz': 2900})
        self.assertEqual(info['memory'], {'totalBytes': 130479124 * 1024})
        self.assertEqual(info['sources'], {'perf': False, 'bandwidth': None, 'power': 'socket', 'gpuBusy': 'activity'})
        self.assertEqual(info['power'], {'label': 'APU socket power'})
        self.assertEqual(info['engine'], {'unit': 'gufo.service'})
        self.assertEqual(info['intervalMs'], 500)
        self.assertIsNone(info['network'])    # no /sys/class/net or /sys/block in this fixture
        self.assertIsNone(info['disks'])
        json.dumps(info, allow_nan=False)

    def test_first_sample_has_null_rates(self):
        s = self.host.compute(None, self.host.read())
        self.assertIsNone(s['cpu']['usage'])
        self.assertEqual(s['cpu']['coreUsage'], [None] * 4)
        self.assertEqual(s['cpu']['coreMhz'], [None] * 4)
        self.assertIsNone(s['cpu']['mhz'])
        self.assertIsNone(s['throttling'])
        self.assertEqual(s['gpu']['tempC'], 49.5)            # instantaneous values are there already
        self.assertEqual(s['power']['watts'], 7.58)
        self.assertEqual(s['fans'], [{'label': 'Fan 1', 'rpm': None, 'duty': None},
                                     {'label': 'Fan 2', 'rpm': None, 'duty': None},
                                     {'label': 'Fan 3', 'rpm': None, 'duty': None}])
        self.assertIsNone(s['net'])            # missing sources stay null
        self.assertIsNone(s['disk'])

    def test_rates_clocks_and_values(self):
        a = self.host.read()
        # cpu1 fully busy at 5098 MHz, cpu3 at 50 % at 3000 MHz, others idle
        write(self.root, '/proc/stat', proc_stat([(100, 1050), (150, 1000), (100, 1050), (125, 1025)]))
        write(self.root, '/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq', '5098000\n')
        write(self.root, '/sys/devices/system/cpu/cpu3/cpufreq/scaling_cur_freq', '3000000\n')
        write(self.root, '/sys/class/drm/card1/device/gpu_metrics',
              gpu_metrics_blob(activity=97, gfxclk=2720, gfx_temp=6150, gfx_mw=55200, socket_mw=156200, core_mw=6100,
                               throttle=(0, 11, 0, 0, 0, 0, 0)), 'wb')
        b = self.host.read()
        b['mono'] = a['mono'] + 0.5
        s = self.host.compute(a, b, self.host.fans.read())
        cpu = s['cpu']
        self.assertEqual(cpu['coreUsage'], [0.0, 100.0, 0.0, 50.0])
        self.assertEqual(cpu['coreMhz'], [None, 5098, None, 3000])
        self.assertEqual(cpu['mhz'], round((5098 * 100 + 3000 * 50) / 150))
        self.assertEqual(cpu['mhzPeak'], 5098)
        self.assertEqual(cpu['usage'], 37.5)
        self.assertEqual(cpu['tempC'], 48.25)
        self.assertEqual(cpu['powerW'], 6.1)
        self.assertEqual(s['gpu'], {'usage': 97, 'mhz': 2720, 'tempC': 61.5, 'powerW': 55.2,
                                    'memUsedBytes': 192184320, 'memTotalBytes': 1073741824})
        self.assertEqual(s['power'], {'watts': 156.2, 'parts': {'gpu': 55.2, 'cpu': 6.1, 'dram': None}})
        self.assertTrue(s['throttling'])
        mem = s['memory']
        self.assertEqual(mem['gpuBytes'], 116784360 * 1024)
        self.assertEqual(mem['usedBytes'], (130479124 - 6103420) * 1024)
        self.assertEqual(mem['swapUsedBytes'], (8388604 - 8388376) * 1024)
        self.assertIsNone(mem['readBps'])  # no perf in the fixture
        self.assertEqual(s['fans'][0], {'label': 'Fan 1', 'rpm': 1200, 'duty': 40})
        self.assertEqual(s['fans'][2], {'label': 'Fan 3', 'rpm': 0, 'duty': None})
        json.dumps(s, allow_nan=False)

    def test_amd_pstate_fallback_value_ignored(self):
        write(self.root, '/sys/devices/system/cpu/cpu0/cpufreq/scaling_driver', 'amd-pstate-epp\n')
        for i in range(4):
            write(self.root, f'/sys/devices/system/cpu/cpu{i}/cpufreq/scaling_min_freq', '2000000\n')
        host = H.Host(H.Fs(self.root), 'llm', 500)
        a = host.read()
        write(self.root, '/proc/stat', proc_stat([(102, 1098), (150, 1050), (100, 1100), (100, 1100)]))
        write(self.root, '/sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq', '4900000\n')
        b = host.read()
        s = host.compute(a, b)
        self.assertEqual(s['cpu']['coreMhz'], [None, 4900, None, None])   # cpu0 is busy but reports the fallback
        self.assertEqual((s['cpu']['mhz'], s['cpu']['mhzPeak']), (4900, 4900))

    def test_df_bandwidth_from_group(self):
        g = FakeGroup(['rd0', 'rd4', 'rd8', 'rd12', 'wr0', 'wr4', 'wr8', 'wr12'], [256.0] * 8)
        self.host.groups['df'] = g
        a = self.host.read()
        b = self.host.read()
        a['perf_df'] = (0, 0, [0] * 8)
        b['perf_df'] = (10**9, 10**9, [1000] * 4 + [100] * 4)
        b['mono'] = a['mono'] + 0.5
        s = self.host.compute(a, b)
        self.assertEqual(s['memory']['readBps'], int(4 * 1000 * 256 / 0.5))
        self.assertEqual(s['memory']['writeBps'], int(4 * 100 * 256 / 0.5))
        self.assertEqual(self.host.sources()['bandwidth'], 'amd_df')

    def test_perf_generation_change_drops_rates(self):
        a = self.host.read()
        self.host.perf_gen += 1
        b = self.host.read()
        self.assertIsNone(self.host.compute(a, b)['cpu']['usage'])


class TestHostIntel(TmpRoot):
    def setUp(self):
        super().setUp()
        make_intel(self.root)
        self.host = H.Host(H.Fs(self.root), 'portal', 500)

    def test_info(self):
        info = self.host.info()
        self.assertEqual(info['gpu'], {'name': 'Intel HD Graphics 510', 'maxMhz': 950})
        self.assertEqual(info['cpu']['cores'], 2)
        self.assertEqual(info['sources'], {'perf': False, 'bandwidth': None, 'power': None, 'gpuBusy': 'awake'})
        self.assertIsNone(info['power'])
        self.assertIsNone(info['engine'])

    def test_awake_fallback_and_nulls(self):
        a = self.host.read()
        write(self.root, '/sys/class/drm/card0/power/rc6_residency_ms', '1400\n')  # 400 ms idle of 500
        write(self.root, '/sys/class/drm/card0/gt_act_freq_mhz', '350\n')
        b = self.host.read()
        b['mono'] = a['mono'] + 0.5
        s = self.host.compute(a, b)
        self.assertEqual(s['gpu']['usage'], 20.0)
        self.assertEqual(s['gpu']['mhz'], 350)
        self.assertEqual(s['gpu']['tempC'], 31.0)  # package temperature (no iGPU sensor)
        self.assertIsNone(s['gpu']['memTotalBytes'])
        self.assertIsNone(s['memory']['gpuBytes'])
        self.assertIsNone(s['power']['watts'])
        self.assertEqual(s['fans'], [])
        self.assertIsNone(s['throttling'])

    def test_rapl_imc_and_pmu_busy(self):
        self.host.groups['rapl'] = FakeGroup(['pkg', 'ram', 'cores', 'gpu'], [2 ** -32] * 4)
        self.host.groups['imc'] = FakeGroup(['rd', 'wr'], [64.0, 64.0])
        self.host.groups['i915'] = FakeGroup(['rcs0'], [1.0])
        a, b = self.host.read(), self.host.read()
        b['mono'] = a['mono'] + 0.5
        J = 2 ** 32
        a['perf_rapl'], b['perf_rapl'] = (0, 0, [0, 0, 0, 0]), (1, 1, [J // 10, J // 5, J // 20, J // 100])
        a['perf_imc'], b['perf_imc'] = (0, 0, [0, 0]), (1, 1, [1000, 500])
        a['perf_i915'], b['perf_i915'] = (0, 0, [0]), (1, 1, [250_000_000])
        s = self.host.compute(a, b)
        self.assertEqual(s['power']['watts'], round((0.1 + 0.2) / 0.5, 2))
        self.assertEqual(s['power']['parts'], {'gpu': 0.02, 'cpu': 0.1, 'dram': 0.4})
        self.assertEqual(s['cpu']['powerW'], 0.1)
        self.assertEqual(s['gpu']['powerW'], 0.02)
        self.assertEqual(s['gpu']['usage'], 50.0)
        self.assertEqual(s['memory']['readBps'], 1000 * 64 * 2)
        self.assertEqual(self.host.sources(), {'perf': False, 'bandwidth': 'uncore_imc', 'power': 'rapl', 'gpuBusy': 'pmu'})


class TestNetDisk(TmpRoot):
    def setUp(self):
        super().setUp()
        make_intel(self.root)
        make_net_disk(self.root)
        self.host = H.Host(H.Fs(self.root), 'portal', 500)
        self.host.space = H.FsSpace(H.Fs(self.root), statvfs=fake_statvfs(self.root))

    def test_local_filesystems(self):
        self.assertEqual(H.local_filesystems(MOUNTS), [('/dev/dm-0', '/'), ('/dev/nvme0n1p1', '/boot/efi'),
                                                       ('/dev/sda1', '/srv/my data')])

    def test_info_lists_what_is_counted(self):
        info = self.host.info()
        self.assertEqual(info['network'], {'interfaces': ['enp1s0', 'wlan0']})
        self.assertEqual(info['disks'], {'devices': ['nvme0n1', 'sda'], 'mounts': ['/', '/boot/efi', '/srv/my data']})

    def test_rates_and_space(self):
        a = self.host.read()
        write(self.root, '/proc/net/dev', net_dev({'lo': (9000, 9000), 'docker0': (5000, 5000), 'veth1a2b': (900, 900),
                                                   'enp1s0': (60_000, 4_000), 'wlan0': (600, 50), 'wg0': (900, 900)}))
        write(self.root, '/proc/diskstats', disk_stats({'nvme0n1': (1100, 2400), 'nvme0n1p1': (1000, 2300),
                                                        'dm-0': (900, 2200), 'loop0': (9, 0), 'zram0': (9, 9),
                                                        'sda': (10, 20)}))
        b = self.host.read()
        b['mono'] = a['mono'] + 0.5
        first = self.host.compute(None, a)
        self.assertEqual(first['net'], {'rxBps': None, 'txBps': None})
        self.assertEqual((first['disk']['readBps'], first['disk']['totalBytes']), (None, 1510 * 4096))
        s = self.host.compute(a, b)
        self.assertEqual(s['net'], {'rxBps': (50_000 + 500) * 2, 'txBps': 2_000 * 2})
        self.assertEqual(s['disk'], {'readBps': 100 * 512 * 2, 'writeBps': 400 * 512 * 2,
                                     'totalBytes': (1000 + 10 + 500) * 4096, 'freeBytes': (400 + 5 + 100) * 4096})
        json.dumps(s, allow_nan=False)

    def test_counter_reset_and_vanished_interface_add_nothing(self):
        a = self.host.read()
        write(self.root, '/proc/net/dev', net_dev({'enp1s0': (50, 2_500)}))
        b = self.host.read()
        b['mono'] = a['mono'] + 1.0
        self.assertEqual(self.host.compute(a, b)['net'], {'rxBps': 0, 'txBps': 500})

    def test_space_refreshes_in_the_background(self):
        space = H.FsSpace(H.Fs(self.root), period=0.05, statvfs=fake_statvfs(self.root))
        self.assertEqual(space.get(), (1510 * 4096, 505 * 4096))
        SPACE['/'] = (1000, 300)
        try:
            time.sleep(0.06)
            self.assertEqual(space.get(), (1510 * 4096, 505 * 4096))   # answers at once with the last result
            for _ in range(100):
                if space.get() == (1510 * 4096, 405 * 4096):
                    break
                time.sleep(0.01)
            self.assertEqual(space.get(), (1510 * 4096, 405 * 4096))
        finally:
            SPACE['/'] = (1000, 400)

    def test_a_table_longer_than_one_read_is_read_to_its_end(self):
        write(self.root, '/long', 'x' * 10_000)
        page = lambda fd, size, offset, pread=os.pread: pread(fd, min(size, 4096), offset)     # as procfs answers
        with mock.patch.object(os, 'pread', page):
            self.assertEqual(H.Src(self.root + '/long', 16384).read(), b'x' * 10_000)

    def test_no_sources(self):
        for path in ('/proc/net/dev', '/proc/diskstats', '/proc/self/mounts'):
            os.remove(self.root + path)
        host = H.Host(H.Fs(self.root), 'portal', 500)
        s = host.compute(host.read(), host.read())
        self.assertEqual((s['net'], s['disk']), (None, None))


class TestMeter(TmpRoot):
    def test_amd_socket_power_is_integrated(self):
        make_amd(self.root)
        m = H.Meter(H.Host(H.Fs(self.root), 'llm', 500), period=3600)
        m.start()
        self.assertEqual(m.snapshot()['energyJ'], 0.0)
        write(self.root, '/sys/class/drm/card1/device/gpu_metrics', gpu_metrics_blob(socket_mw=12_423), 'wb')
        m._mono -= 2.0                     # the last reading (7.577 W) was 2 s ago
        m.tick()
        self.assertAlmostEqual(m.snapshot()['energyJ'], (7.577 + 12.423) / 2 * 2.0, delta=0.05)
        m.stop()

    def test_intel_rapl_counts_package_and_dram(self):
        make_intel(self.root)
        host = H.Host(H.Fs(self.root), 'portal', 500)
        self.assertIsNone(H.Meter(host).rapl)               # no RAPL PMU in the fixture: no energy
        host.groups['rapl'] = FakeGroup(['pkg', 'ram', 'cores'], [1.0] * 3)
        m = H.Meter(host, period=3600)
        group = FakeGroup(['pkg', 'ram'], [2 ** -32] * 2)
        m.rapl = group
        m.start()
        self.assertEqual(group.opened, 1)
        group.counts = [5 * 2 ** 32, 2 ** 31]
        m.tick()
        self.assertEqual(m.snapshot()['energyJ'], 5.5)
        group.counts = [9 * 2 ** 32, 2 ** 32]
        m.tick()
        self.assertEqual(m.snapshot()['energyJ'], 10.0)
        m.stop()
        self.assertEqual(group.closed, 1)

    def test_no_power_source(self):
        make_intel(self.root)
        m = H.Meter(H.Host(H.Fs(self.root), 'portal', 500), period=3600)
        m.start()
        snap = m.snapshot()
        self.assertEqual((snap['energyJ'], snap['rxBytes'], snap['txBytes']), (None, None, None))  # nor /proc/net/dev
        m.stop()

    def test_bytes_survive_resets_and_interfaces_coming_and_going(self):
        make_intel(self.root)
        make_net_disk(self.root)
        m = H.Meter(H.Host(H.Fs(self.root), 'portal', 500), period=3600)
        m.start()
        self.assertEqual((m.snapshot()['rxBytes'], m.snapshot()['txBytes']), (0, 0))   # counting starts now
        steps = [
            ({'enp1s0': (15_000, 2_500), 'wlan0': (100, 50), 'veth1a2b': (90_000, 90_000)}, (5_000, 500)),
            ({'enp1s0': (15_000, 2_500)}, (5_000, 500)),                       # wlan0 gone
            ({'enp1s0': (400, 2_600), 'wlan0': (30, 10)}, (5_430, 610)),       # enp1s0 reset; wlan0 back from zero
            ({'enp1s0': (1_400, 2_600), 'wlan0': (30, 10), 'usb0': (7, 3)}, (6_437, 613)),  # usb0 new: from zero
        ]
        for counters, want in steps:
            write(self.root, '/proc/net/dev', net_dev(counters))
            for name in counters:
                os.makedirs(self.root + f'/sys/class/net/{name}' + ('' if name.startswith('veth') else '/device'),
                            exist_ok=True)
            m.tick()
            snap = m.snapshot()
            self.assertEqual((snap['rxBytes'], snap['txBytes']), want, counters)
        m.stop()

    def test_runs_without_viewers(self):
        make_amd(self.root)
        m = H.Meter(H.Host(H.Fs(self.root), 'llm', 500), period=0.02)
        m.start()
        t0 = m.snapshot()['t']
        time.sleep(0.1)
        snap = m.snapshot()
        m.stop()
        self.assertGreater(snap['t'], t0)
        self.assertGreater(snap['energyJ'], 0)
        self.assertEqual(len(snap['instance']), 16)
        self.assertNotEqual(snap['instance'], H.Meter(H.Host(H.Fs(self.root), 'llm', 500)).instance)


class TestGpuName(TmpRoot):
    def test_names(self):
        write(self.root, '/usr/share/hwdata/pci.ids', PCI_IDS)
        fs = H.Fs(self.root)
        for vendor, dev, model, kind, want in [
            ('0x1002', '0x1586', 'AMD RYZEN AI MAX+ 395 w/ Radeon 8060S', 'amdgpu', 'Radeon 8060S'),
            ('0x1002', '0x15bf', 'AMD Ryzen 7 8840U w/ Radeon 780M Graphics', 'amdgpu', 'Radeon 780M Graphics'),
            ('0x1002', '0x1586', 'Some CPU', 'amdgpu',
             'Strix Halo [Radeon Graphics / Radeon 8050S Graphics / Radeon 8060S Graphics]'),
            ('0x8086', '0x1902', 'Intel(R) Pentium(R) CPU G4400T', 'i915', 'Intel HD Graphics 510'),
            ('0x1234', '0x0001', 'x', 'amdgpu', 'AMD GPU'),
        ]:
            write(self.root, '/dev0/vendor', vendor + '\n')
            write(self.root, '/dev0/device', dev + '\n')
            self.assertEqual(H.gpu_display_name(fs, '/dev0', kind, model), want)


class TestSampler(TmpRoot):
    def setUp(self):
        super().setUp()
        make_amd(self.root)
        self.host = H.Host(H.Fs(self.root), 'llm', 50)
        self.group = FakeGroup(['x'], [1.0])
        self.host.groups['test'] = self.group
        self.sampler = H.Sampler(self.host, 0.05, keepalive=0.2, perf_linger=0.8, fan_period=0.05)
        self.sampler.start()

    def tearDown(self):
        self.sampler.stop()
        super().tearDown()

    def test_idle_until_watched_then_stops(self):
        time.sleep(0.2)
        self.assertEqual(self.sampler.seq, 0)  # nobody watching: nothing sampled
        self.assertTrue(self.sampler.add_stream())
        seq, s1 = self.sampler.wait_newer(0, 2)
        seq, s2 = self.sampler.wait_newer(seq, 2)
        self.assertIsNone(s1['throttling'])
        self.assertIsNotNone(s2['throttling'])          # computed against the previous reading
        self.assertEqual(self.group.opened, 1)
        time.sleep(0.2)
        self.assertEqual(s2['fans'][0]['rpm'] if s2['fans'][0]['rpm'] is not None else 1200, 1200)
        self.sampler.remove_stream()
        time.sleep(0.15)
        n = self.sampler.seq
        time.sleep(0.25)
        self.assertEqual(self.sampler.seq, n)   # stopped
        self.assertEqual(self.group.closed, 0)
        time.sleep(0.6)
        self.assertGreaterEqual(self.group.closed, 1)     # perf closed after the linger time
        self.assertFalse(self.host.perf_open)

    def test_stream_limit(self):
        for _ in range(4):
            self.assertTrue(self.sampler.add_stream())
        self.assertFalse(self.sampler.add_stream())
        for _ in range(4):
            self.sampler.remove_stream()

    def test_sample_keepalive(self):
        s = self.sampler.current()
        self.assertIsNotNone(s)
        time.sleep(0.12)
        s2 = self.sampler.current()
        self.assertIsNotNone(s2['throttling'])   # second call within the keepalive has a previous reading
        time.sleep(0.5)
        n = self.sampler.seq
        time.sleep(0.2)
        self.assertEqual(self.sampler.seq, n)


QUADLET = f"""[Unit]
Description=Test engine
Documentation=https://github.com/gufo-org/gufo/blob/v0.31.0/docs/SERVER.md

[Container]
ContainerName=gufo
Image={REPO}@{D_OLD}
Pull=missing
# a comment that mentions Image=something
Exec=gufo serve --host 0.0.0.0 \\
      --port 8080
\t  \n[Service]
TimeoutStartSec=600
"""


class FakeEngineState:
    def __init__(self):
        self.lock = threading.Lock()
        self.local = {f'{REPO}@{D_OLD}': {'id': 'b59e98734336' + '0' * 52, 'version': '0.31.0', 'created': 1793794732},
                      f'{REPO}@{D_THIRD}': {'id': 'd' * 64, 'version': '0.29.0', 'created': 1790000000}}
        self.remote = {f'{REPO}@{D_NEW}': {'id': 'e' * 64, 'version': '0.34.0', 'created': 1795000000},
                       f'{REPO}@{D_BAD}': {'id': 'f' * 64, 'version': '0.35.0', 'created': 1796000000}}
        self.build = {D_OLD: '0.31.0 (be7bd3b)', D_NEW: '0.34.0 (abc1234)', D_BAD: '0.35.0 (dead000)',
                      D_THIRD: '0.29.0 (0000000)'}
        self.never_ready = {D_BAD}
        self.running = D_OLD
        self.ready = True
        self.restart_fail = False
        self.restarts = 0
        self.pull_block = threading.Event()
        self.pull_block.set()
        self.pull_started = threading.Event()
        self.calls = []
        self.journal = []   # the engine unit's journal entries, as journalctl -o json gives them
        self.inactive = set()   # units `systemctl show` reports inactive
        self.router_loaded = True
        self.router_calls = []


class FakeRunner(H.Runner):
    def __init__(self, state, quadlet_path):
        self.s, self.quadlet = state, quadlet_path
        self.stopped_units = []

    def _images_json(self):
        out = []
        for ref, im in self.s.local.items():
            # like a multi-arch pull: the platform manifest digest sorts before the index digest
            platform = REPO + '@sha256:0' + im['id'][:63]
            out.append({'Id': im['id'], 'RepoTags': None, 'RepoDigests': [platform, ref],
                        'Digest': ref.split('@', 1)[1], 'Size': 1905496024,
                        'Labels': {'org.opencontainers.image.version': im['version'],
                                   'org.opencontainers.image.revision': 'unknown',
                                   'org.gufo.engine.revision': 'rev-' + im['version']},
                        'Names': [ref], 'Created': im['created']})
            out.append(dict(out[-1]))  # podman lists an image once per name
        return json.dumps(out)

    def run(self, argv, timeout):
        self.s.calls.append(argv)
        if argv[:6] == self.PODMAN:
            args = argv[argv.index('podman') + 1:]
            if args[:3] == ['images', '--format', 'json']:
                return 0, self._images_json(), ''
            if args[:2] == ['image', 'exists']:
                return (0 if args[2] in self.s.local else 1), '', ''
            if args[0] == 'rmi':
                if args[1] in self.s.local:
                    del self.s.local[args[1]]
                    return 0, 'Untagged', ''
                return 1, '', 'no such image'
            return 125, '', 'unexpected podman call'
        if argv[:2] == ['journalctl', '--user']:
            return 0, ''.join(json.dumps(entry) + '\n' for entry in self.s.journal), ''
        if argv[:2] == ['systemctl', '--user']:
            cmd = argv[2]
            if cmd == 'show':
                if argv[3] in self.s.inactive:
                    return 0, 'ActiveState=inactive\nSubState=dead\n', ''
                return 0, 'ActiveState=active\nSubState=running\n', ''
            if cmd == 'daemon-reload':
                return 0, '', ''
            if cmd == 'restart':
                self.s.restarts += 1
                if self.s.restart_fail:
                    self.s.ready = False
                    return 1, '', 'Job failed'
                with open(self.quadlet) as f:
                    _, image = H.quadlet_image(f.read())
                digest = image.split('@')[1]
                self.s.running = digest
                self.s.ready = digest not in self.s.never_ready
                return 0, '', ''
            if cmd == 'stop':
                self.stopped_units.append(argv[3])
                self.s.pull_block.set()
                return 0, '', ''
        return 127, '', 'unexpected command'

    def stream(self, argv, on_line, timeout):
        self.s.calls.append(argv)
        args = argv[argv.index('podman') + 1:]
        assert args[0] == 'pull'
        assert any(a.startswith('--unit=portal-hostd-') for a in argv)
        on_line('Trying to pull ' + args[1] + '...')
        self.s.pull_started.set()
        if not self.s.pull_block.wait(5) or self.stopped_units:
            return 1
        if args[1] in self.s.remote:
            self.s.local[args[1]] = self.s.remote[args[1]]
            on_line('Writing manifest to image destination')
            return 0
        on_line('Error: manifest unknown')
        return 125


class FakeEngineHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        s = self.server.state
        if not s.ready:
            body, code = b'{"error":{"code":"loading"}}', 503
        elif self.path == '/ready':
            body, code = b'{"status":"ready"}', 200
        elif self.path == '/props':
            body, code = json.dumps({'build_info': s.build[s.running], 'total_slots': 7}).encode(), 200
        else:
            body, code = b'{}', 404
        self.send_response(code)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def fake_engine(case):
    """An H.Engine over a quadlet under case.root, a FakeRunner (case.runner) and a fake engine HTTP server."""
    case.state = FakeEngineState()
    write(case.root, '/quadlets/gufo.container', QUADLET)
    case.quadlet = case.root + '/quadlets/gufo.container'
    os.chmod(case.quadlet, 0o640)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeEngineHandler)
    srv.state = case.state
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    case.addCleanup(srv.server_close)
    case.addCleanup(srv.shutdown)
    case.runner = FakeRunner(case.state, case.quadlet)
    return H.Engine('gufo.service', case.quadlet, f'http://127.0.0.1:{srv.server_port}', case.root + '/state',
                    case.runner, ready_timeout=1.0, restart_timeout=5, poll=0.05, http_timeout=1.0)


class FakeRouterHandler(http.server.BaseHTTPRequestHandler):
    """llama-swap's routes that hostd uses, over the same FakeEngineState."""

    def log_message(self, *a):
        pass

    def _send(self, code, body):
        self.send_response(code)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        s = self.server.state
        s.router_calls.append(('GET', self.path))
        if self.path == '/running':
            running = [{'model': 'qwen3.8-flash-next', 'state': 'ready'}] if s.router_loaded else []
            return self._send(200, json.dumps({'running': running}).encode())
        if self.path == '/upstream/qwen3.8-flash-next/v1/models':
            with open(self.server.quadlet) as f:
                s.running = H.quadlet_image(f.read())[1].split('@')[1]
            s.ready = s.running not in s.never_ready
            s.router_loaded = True
            s.inactive.discard('gufo.service')
            return self._send(200, b'{"data":[]}') if s.ready else self._send(502, b'upstream did not become ready')
        self._send(404, b'')

    def do_POST(self):
        s = self.server.state
        s.router_calls.append(('POST', self.path))
        if self.path == '/api/models/unload':
            s.router_loaded, s.ready = False, False
            s.inactive.update({'gufo.service', 'gufo-image.service'})
            return self._send(200, b'{"msg":"ok"}')
        self._send(404, b'')


class EngineCase(TmpRoot):
    def setUp(self):
        super().setUp()
        self.engine = fake_engine(self)

    def wait_job(self, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            j = self.engine.job
            if j and j.phase != 'running':
                return j.to_json()
            time.sleep(0.02)
        self.fail('job did not finish')

    def read_quadlet(self):
        with open(self.quadlet) as f:
            return f.read()


class TestQuadlet(unittest.TestCase):
    def test_rewrite_only_image_and_doc_version(self):
        new = H.quadlet_rewrite(QUADLET, f'{REPO}@{D_NEW}', '0.34.0')
        old_lines, new_lines = QUADLET.splitlines(keepends=True), new.splitlines(keepends=True)
        self.assertEqual(len(old_lines), len(new_lines))
        changed = [i for i, (a, b) in enumerate(zip(old_lines, new_lines)) if a != b]
        self.assertEqual(len(changed), 2)
        self.assertIn(f'Image={REPO}@{D_NEW}\n', new_lines)
        self.assertIn('Documentation=https://github.com/gufo-org/gufo/blob/v0.34.0/docs/SERVER.md\n', new_lines)
        self.assertEqual(H.quadlet_rewrite(QUADLET, f'{REPO}@{D_NEW}', None).count('v0.31.0'), 1)

    def test_crlf_and_spacing_preserved(self):
        text = '[Container]\r\nImage = old@x  \r\nExec=a\r\n'
        self.assertEqual(H.quadlet_rewrite(text, 'new@y', None), '[Container]\r\nImage = new@y  \r\nExec=a\r\n')

    def test_needs_exactly_one_image(self):
        with self.assertRaises(H.StepError):
            H.quadlet_image('[Container]\nExec=x\n')
        with self.assertRaises(H.StepError):
            H.quadlet_image('[Container]\nImage=a\nImage=b\n')

    def test_repository_of(self):
        self.assertEqual(H.repository_of(f'{REPO}@{D_OLD}'), REPO)
        self.assertEqual(H.repository_of('localhost:5000/a/b:1.2'), 'localhost:5000/a/b')
        self.assertEqual(H.repository_of('docker.io/library/busybox:1.37'), 'docker.io/library/busybox')


class TestEngine(EngineCase):
    def test_status(self):
        st = self.engine.status()
        self.assertEqual(st['repository'], REPO)
        self.assertEqual(st['image'], f'{REPO}@{D_OLD}')
        self.assertEqual(st['digest'], D_OLD)
        self.assertEqual(st['version'], '0.31.0')
        self.assertEqual(st['revision'], 'rev-0.31.0')
        self.assertEqual((st['state'], st['subState'], st['ready']), ('active', 'running', True))
        self.assertEqual(st['buildInfo'], '0.31.0 (be7bd3b)')
        self.assertIsNone(st['previous'])
        self.assertIsNone(st['job'])
        self.assertEqual([i['digest'] for i in st['images']], [D_OLD, D_THIRD])  # newest first, deduplicated
        self.assertEqual(st['images'][0]['id'], 'b59e98734336')
        self.assertEqual(st['images'][0]['createdAt'], 1793794732000)
        self.assertTrue(st['images'][0]['current'])
        self.assertFalse(st['images'][1]['current'])
        json.dumps(st, allow_nan=False)

    def test_validation(self):
        for bad in [None, 'x', f'{REPO}:latest', f'{REPO}@sha256:abc', f'{REPO}@sha256:' + 'A' * 64, f'{REPO}@{D_NEW}\n']:
            with self.assertRaises(H.ApiError) as c:
                self.engine.start_pull(bad)
            self.assertEqual(c.exception.code, 'invalid_image')
        with self.assertRaises(H.ApiError) as c:
            self.engine.start_pull(f'docker.io/library/busybox@{D_NEW}')
        self.assertEqual(c.exception.code, 'wrong_repository')
        with self.assertRaises(H.ApiError) as c:
            self.engine.start_apply(f'{REPO}@{D_NEW}', None)
        self.assertEqual(c.exception.code, 'not_pulled')
        for bad in ['v1', '0.31.0\n', '０.３１.０']:      # the version is written into the quadlet's Documentation=
            with self.assertRaises(H.ApiError) as c:
                self.engine.start_apply(f'{REPO}@{D_OLD}', bad)
            self.assertEqual(c.exception.code, 'invalid_version')

    def test_pull_then_apply(self):
        job = self.engine.start_pull(f'{REPO}@{D_NEW}')
        self.assertEqual((job['kind'], job['phase']), ('pull', 'running'))
        j = self.wait_job()
        self.assertEqual(j['phase'], 'succeeded', j)
        self.assertIn(f'{REPO}@{D_NEW}', self.state.local)

        self.engine.start_apply(f'{REPO}@{D_NEW}', '0.34.0')
        j = self.wait_job()
        self.assertEqual(j['phase'], 'succeeded', j)
        self.assertEqual(j['step'], 'Done')
        self.assertFalse(j['rolledBack'])
        q = self.read_quadlet()
        self.assertEqual(q, H.quadlet_rewrite(QUADLET, f'{REPO}@{D_NEW}', '0.34.0'))
        self.assertEqual(os.stat(self.quadlet).st_mode & 0o777, 0o640)   # mode kept
        with open(self.engine.prev_path) as f:
            self.assertEqual(f.read(), QUADLET)
        st = self.engine.status()
        self.assertEqual((st['digest'], st['version'], st['buildInfo']), (D_NEW, '0.34.0', '0.34.0 (abc1234)'))
        self.assertEqual(st['previous'], {'image': f'{REPO}@{D_OLD}', 'digest': D_OLD, 'version': '0.31.0'})
        self.assertEqual([(i['digest'], i['current'], i['previous']) for i in st['images']],
                         [(D_NEW, True, False), (D_OLD, False, True), (D_THIRD, False, False)])
        self.assertEqual(st['job']['id'], j['id'])

        # Switching back is an apply like any other.
        self.engine.start_apply(f'{REPO}@{D_OLD}', '0.31.0')
        j = self.wait_job()
        self.assertEqual((j['kind'], j['phase'], j['image'], j['version']), ('apply', 'succeeded', f'{REPO}@{D_OLD}', '0.31.0'))
        self.assertEqual(self.state.running, D_OLD)

    def test_failed_apply_bogus_version_rolls_back(self):
        self.state.local[f'{REPO}@{D_NEW}'] = self.state.remote[f'{REPO}@{D_NEW}']
        self.engine.start_apply(f'{REPO}@{D_NEW}', '9.9.9')
        j = self.wait_job()
        self.assertEqual(j['phase'], 'failed')
        self.assertTrue(j['rolledBack'])
        self.assertEqual(j['step'], 'Failed; the previous version runs again')
        self.assertIn('build_info', j['error'])
        self.assertEqual(self.read_quadlet(), QUADLET)
        self.assertEqual(self.state.running, D_OLD)
        self.assertFalse(os.path.exists(self.engine.prev_path))  # no previous before, none after
        self.assertIsNone(self.engine.status()['previous'])
        self.assertTrue(self.engine.ready())

    def test_failed_apply_keeps_the_saved_previous(self):
        # 0.34 runs and 0.31 is the saved previous; a failed update to D_BAD must put 0.34 back and keep 0.31 on record.
        self.state.local[f'{REPO}@{D_NEW}'] = self.state.remote[f'{REPO}@{D_NEW}']
        self.engine.start_apply(f'{REPO}@{D_NEW}', '0.34.0')
        self.assertEqual(self.wait_job()['phase'], 'succeeded')
        self.state.local[f'{REPO}@{D_BAD}'] = self.state.remote[f'{REPO}@{D_BAD}']
        self.engine.start_apply(f'{REPO}@{D_BAD}', None)
        j = self.wait_job()
        self.assertEqual((j['phase'], j['rolledBack']), ('failed', True))
        self.assertEqual(self.state.running, D_NEW)
        with open(self.engine.prev_path) as f:
            self.assertEqual(f.read(), QUADLET)
        self.assertEqual(self.engine.status()['previous']['version'], '0.31.0')

    def test_failed_apply_never_ready_rolls_back(self):
        self.state.local[f'{REPO}@{D_BAD}'] = self.state.remote[f'{REPO}@{D_BAD}']
        self.engine.start_apply(f'{REPO}@{D_BAD}', None)
        j = self.wait_job()
        self.assertEqual((j['phase'], j['rolledBack']), ('failed', True))
        self.assertIn('/ready', j['error'])
        self.assertEqual(self.state.running, D_OLD)
        self.assertEqual(self.read_quadlet(), QUADLET)

    def test_failed_apply_names_the_engines_own_reason(self):
        self.state.local[f'{REPO}@{D_BAD}'] = self.state.remote[f'{REPO}@{D_BAD}']
        self.state.journal = [{'_COMM': 'systemd', 'MESSAGE': 'Starting gufo.service...'},
                              {'_COMM': 'conmon', 'MESSAGE': "error: unexpected argument '--bogus' found"}]
        self.engine.start_apply(f'{REPO}@{D_BAD}', None)
        j = self.wait_job()
        self.assertEqual((j['phase'], j['rolledBack']), ('failed', True))
        self.assertIn("the engine said:\nerror: unexpected argument '--bogus' found", j['error'])
        self.assertNotIn('Starting gufo', j['error'])
        journal = next(c for c in self.state.calls if c[:2] == ['journalctl', '--user'])
        self.assertTrue(journal[journal.index('--since') + 1].startswith('@'), 'only what the engine said since the restart')

    def test_rollback_failure_reported(self):
        self.state.local[f'{REPO}@{D_NEW}'] = self.state.remote[f'{REPO}@{D_NEW}']
        self.state.restart_fail = True
        self.engine.start_apply(f'{REPO}@{D_NEW}', None)
        j = self.wait_job()
        self.assertEqual(j['phase'], 'failed')
        self.assertFalse(j['rolledBack'])
        self.assertEqual(j['step'], 'Failed; the rollback failed too')
        self.assertIn('rollback failed too', j['error'])
        self.assertEqual(self.read_quadlet(), QUADLET)          # the saved quadlet was still written back

    def test_job_running_and_cancel(self):
        self.state.pull_block.clear()
        self.engine.start_pull(f'{REPO}@{D_NEW}')
        self.assertTrue(self.state.pull_started.wait(5))
        with self.assertRaises(H.ApiError) as c:
            self.engine.start_pull(f'{REPO}@{D_BAD}')
        self.assertEqual(c.exception.code, 'job_running')
        with self.assertRaises(H.ApiError) as c:
            self.engine.delete_image(D_THIRD)
        self.assertEqual(c.exception.code, 'job_running')
        self.assertEqual(self.engine.cancel(), {'cancelled': True})
        j = self.wait_job()
        self.assertEqual(j['phase'], 'cancelled')
        self.assertTrue(self.runner.stopped_units[0].startswith('portal-hostd-'))
        self.assertEqual(self.engine.cancel(), {'cancelled': False})

    def test_pull_failure(self):
        self.engine.start_pull(f'{REPO}@sha256:' + '0' * 64)
        j = self.wait_job()
        self.assertEqual(j['phase'], 'failed')
        self.assertTrue(any('manifest unknown' in line for line in j['log']))

    def test_delete_image(self):
        with self.assertRaises(H.ApiError) as c:
            self.engine.delete_image(D_OLD)
        self.assertEqual(c.exception.code, 'image_current')
        with self.assertRaises(H.ApiError) as c:
            self.engine.delete_image(D_NEW)
        self.assertEqual(c.exception.code, 'not_found')
        for bad in ['sha256:xyz', D_THIRD + '\n']:
            with self.assertRaises(H.ApiError) as c:
                self.engine.delete_image(bad)
            self.assertEqual(c.exception.code, 'invalid_image')
        self.assertEqual(self.engine.delete_image(D_THIRD), {'ok': True})
        self.assertNotIn(f'{REPO}@{D_THIRD}', self.state.local)
        rmi = [c for c in self.state.calls if 'rmi' in c]
        self.assertEqual(rmi[0][-2:], ['rmi', f'{REPO}@{D_THIRD}'])

    def test_bad_quadlet(self):
        with open(self.quadlet, 'w') as f:
            f.write('[Container]\nImage=a@b\nImage=c@d\n')
        with self.assertRaises(H.ApiError) as c:
            self.engine.start_pull(f'{REPO}@{D_NEW}')
        self.assertEqual(c.exception.code, 'quadlet_invalid')

    def test_all_podman_calls_go_through_user_manager(self):
        self.engine.status()
        self.engine.start_pull(f'{REPO}@{D_NEW}')
        self.wait_job()
        for argv in self.state.calls:
            if 'podman' in argv:
                self.assertEqual(argv[:6], ['systemd-run', '--user', '--wait', '--pipe', '--quiet', '--collect'])
            else:
                self.assertEqual(argv[:2], ['systemctl', '--user'])


class TestEngineBehindRouter(EngineCase):
    """The engine behind llama-swap, with an image model's quadlet beside it."""

    def setUp(self):
        super().setUp()
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeRouterHandler)
        srv.state, srv.quadlet = self.state, self.quadlet
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        self.engine.router = H.Router(f'http://127.0.0.1:{srv.server_port}', 'qwen3.8-flash-next', http_timeout=1.0)
        self.image_quadlet = QUADLET.replace('ContainerName=gufo', 'ContainerName=gufo-image')
        write(self.root, '/quadlets/gufo-image.container', self.image_quadlet)
        write(self.root, '/quadlets/other.container', '[Container]\nImage=docker.io/library/busybox:1.37\n')
        self.state.local[f'{REPO}@{D_NEW}'] = self.state.remote[f'{REPO}@{D_NEW}']

    def read(self, name):
        with open(self.root + '/quadlets/' + name) as f:
            return f.read()

    def test_companions_share_the_repository(self):
        self.assertEqual(self.engine.companions(), [self.root + '/quadlets/gufo-image.container'])

    def test_apply_rewrites_every_engine_quadlet_and_restarts_through_llama_swap(self):
        self.engine.start_apply(f'{REPO}@{D_NEW}', '0.34.0')
        j = self.wait_job()
        self.assertEqual(j['phase'], 'succeeded', j)
        self.assertEqual(self.read('gufo-image.container'), H.quadlet_rewrite(self.image_quadlet, f'{REPO}@{D_NEW}', '0.34.0'))
        self.assertEqual(self.read('other.container'), '[Container]\nImage=docker.io/library/busybox:1.37\n')
        self.assertEqual(self.state.running, D_NEW)
        self.assertFalse(any(c[:3] == ['systemctl', '--user', 'restart'] for c in self.state.calls), 'never behind its back')
        self.assertEqual([c for c in self.state.router_calls if c[0] == 'POST'], [('POST', '/api/models/unload')])
        self.assertIn(('GET', '/upstream/qwen3.8-flash-next/v1/models'), self.state.router_calls)
        self.assertIn('Stopping the models (llama-swap)', j['log'][-6])

    def test_failed_apply_puts_every_quadlet_back(self):
        self.state.local[f'{REPO}@{D_BAD}'] = self.state.remote[f'{REPO}@{D_BAD}']
        self.engine.start_apply(f'{REPO}@{D_BAD}', None)
        j = self.wait_job()
        self.assertEqual((j['phase'], j['rolledBack']), ('failed', True), j)
        self.assertIn('llama-swap did not start qwen3.8-flash-next: 502', j['error'])
        self.assertEqual(self.read('gufo.container'), QUADLET)
        self.assertEqual(self.read('gufo-image.container'), self.image_quadlet)
        self.assertEqual(self.state.running, D_OLD)

    def test_unloaded_while_the_image_models_run(self):
        self.assertFalse(self.engine.status()['unloaded'])
        self.state.router_loaded, self.state.ready = False, False
        self.state.inactive.add('gufo.service')
        st = self.engine.status()
        self.assertEqual((st['state'], st['ready'], st['unloaded']), ('inactive', False, True))

    def test_delete_refuses_an_image_a_companion_runs(self):
        write(self.root, '/quadlets/gufo-image.container', QUADLET.replace(D_OLD, D_THIRD))
        with self.assertRaises(H.ApiError) as c:
            self.engine.delete_image(D_THIRD)
        self.assertEqual(c.exception.code, 'image_current')


class HttpCase(TmpRoot):
    max_connections = 16

    def setUp(self):
        super().setUp()
        make_amd(self.root)
        host = H.Host(H.Fs(self.root), 'llm', 50, None)
        self.sampler = H.Sampler(host, 0.05, keepalive=0.3)
        self.meter = H.Meter(host, period=0.05)
        self.app = H.App(host, self.sampler, self.meter, TOKEN, self.make_engine())
        self.server = H.Server(('127.0.0.1', 0), self.app, max_connections=self.max_connections)
        self.port = self.server.server_address[1]
        self.sampler.start()
        self.meter.start()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def make_engine(self):
        return None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.sampler.stop()
        self.meter.stop()
        super().tearDown()

    def req(self, method, path, body=None, token=TOKEN, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        h = dict(headers or {})
        if token:
            h['Authorization'] = 'Bearer ' + token
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        raw = r.read()
        c.close()
        return r.status, (json.loads(raw) if raw else None)


class TestHttp(HttpCase):
    def test_health_and_auth(self):
        self.assertEqual(self.req('GET', '/v1/health', token=None), (200, {'ok': True}))
        st, body = self.req('GET', '/v1/info', token=None)
        self.assertEqual((st, body['error']), (401, 'unauthorized'))
        self.assertEqual(self.req('GET', '/v1/info', token='b' * 40)[0], 401)
        st, info = self.req('GET', '/v1/info')
        self.assertEqual((st, info['role']), (200, 'llm'))
        self.assertEqual(self.req('GET', '/v1/meter', token=None)[0], 401)

    def test_errors(self):
        self.assertEqual(self.req('GET', '/nope'), (404, {'error': 'not_found', 'message': 'no such endpoint'}))
        st, body = self.req('GET', '/v1/engine')
        self.assertEqual((st, body['error']), (404, 'no_engine'))
        st, body = self.req('POST', '/v1/engine/pull', b'x' * 5000)
        self.assertEqual((st, body['error']), (413, 'body_too_large'))
        st, body = self.req('POST', '/v1/info', {})
        self.assertEqual((st, body['error']), (405, 'method_not_allowed'))

    def test_sample(self):
        st, s = self.req('GET', '/v1/sample')
        self.assertEqual(st, 200)
        self.assertEqual(set(s), {'t', 'cpu', 'gpu', 'memory', 'power', 'fans', 'throttling', 'net', 'disk'})
        time.sleep(0.12)
        st, s2 = self.req('GET', '/v1/sample')
        self.assertIsNotNone(s2['throttling'])

    def test_meter(self):
        st, m = self.req('GET', '/v1/meter')
        self.assertEqual(st, 200)
        self.assertEqual(set(m), {'instance', 'startedAt', 't', 'energyJ', 'rxBytes', 'txBytes'})
        self.assertEqual((m['rxBytes'], m['txBytes']), (None, None))   # the AMD fixture has no /proc/net/dev
        time.sleep(0.15)
        st, m2 = self.req('GET', '/v1/meter')
        self.assertEqual(m2['instance'], m['instance'])
        self.assertGreater(m2['t'], m['t'])
        self.assertGreater(m2['energyJ'], m['energyJ'])            # 7.577 W, counted without any stream open
        self.assertEqual(self.sampler.seq, 0)
        self.assertEqual(self.req('POST', '/v1/meter')[0], 405)

    def open_stream(self):
        s = socket.create_connection(('127.0.0.1', self.port), timeout=5)
        s.sendall(f'GET /v1/stream HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\n\r\n'.encode())
        return s

    def read_events(self, s, n):
        buf = b''
        while buf.count(b'\n\n') < n + 1:   # +1 for the header terminator
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
        head, _, rest = buf.partition(b'\r\n\r\n')
        return head.decode(), [e for e in rest.decode().split('\n\n') if e]

    def test_stream(self):
        s = self.open_stream()
        head, events = self.read_events(s, 3)
        s.close()
        self.assertIn('200', head.splitlines()[0])
        self.assertIn('Content-Type: text/event-stream', head)
        self.assertTrue(events[0].startswith('event: info\ndata: '))
        self.assertEqual(json.loads(events[0].split('data: ', 1)[1])['role'], 'llm')
        self.assertTrue(events[1].startswith('event: sample\ndata: '))
        sample = json.loads(events[2].split('data: ', 1)[1])
        self.assertIn('cpu', sample)

    def test_stream_limit(self):
        socks = [self.open_stream() for _ in range(4)]
        for s in socks:
            self.read_events(s, 1)
        st, body = self.req('GET', '/v1/stream')
        self.assertEqual((st, body['error']), (429, 'too_many_streams'))
        for s in socks:
            s.close()
        time.sleep(0.3)   # handlers notice the closed sockets on their next write
        deadline = time.time() + 3
        while self.sampler.streams and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.sampler.streams, 0)

    def test_slow_headers_are_dropped(self):
        old = H.HEADER_TIMEOUT
        H.HEADER_TIMEOUT = 0.5
        try:
            s = socket.create_connection(('127.0.0.1', self.port), timeout=5)
            s.sendall(b'GET /v1/health HTTP/1.1\r\n')
            t = time.time()
            for _ in range(10):
                time.sleep(0.2)
                try:
                    s.sendall(b'X: y\r\n')
                except OSError:
                    break
            data = s.recv(100)
            self.assertLess(time.time() - t, 4)
            self.assertNotIn(b'200 OK', data)
            s.close()
        finally:
            H.HEADER_TIMEOUT = old


class TestConnectionLimit(HttpCase):
    max_connections = 2

    def test_limit(self):
        a = socket.create_connection(('127.0.0.1', self.port))
        b = socket.create_connection(('127.0.0.1', self.port))
        time.sleep(0.2)
        st, body = self.req('GET', '/v1/health', token=None)
        self.assertEqual((st, body['error']), (503, 'too_many_connections'))
        a.close()
        b.close()


class TestHttpEngine(HttpCase):
    def make_engine(self):
        return fake_engine(self)

    def test_endpoints(self):
        st, body = self.req('GET', '/v1/engine')
        self.assertEqual((st, body['unit'], body['digest']), (200, 'gufo.service', D_OLD))
        st, body = self.req('POST', '/v1/engine/pull', {'image': 'nope'})
        self.assertEqual((st, body['error']), (400, 'invalid_image'))
        st, job = self.req('POST', '/v1/engine/pull', {'image': f'{REPO}@{D_NEW}'})
        self.assertEqual((st, job['kind'], job['phase']), (202, 'pull', 'running'))
        for _ in range(100):
            st, body = self.req('GET', '/v1/engine')
            if body['job']['phase'] != 'running':
                break
            time.sleep(0.05)
        self.assertEqual(body['job']['phase'], 'succeeded')
        st, job = self.req('POST', '/v1/engine/apply', {'image': f'{REPO}@{D_NEW}', 'version': '0.34.0'})
        self.assertEqual(st, 202)
        for _ in range(200):
            st, body = self.req('GET', '/v1/engine')
            if body['job']['phase'] != 'running':
                break
            time.sleep(0.05)
        self.assertEqual((body['job']['kind'], body['job']['phase'], body['version']), ('apply', 'succeeded', '0.34.0'))
        st, body = self.req('DELETE', f'/v1/engine/images/{D_NEW}')
        self.assertEqual((st, body['error']), (409, 'image_current'))
        st, body = self.req('DELETE', f'/v1/engine/images/{D_OLD}')
        self.assertEqual((st, body), (200, {'ok': True}))
        st, body = self.req('POST', '/v1/engine/cancel')
        self.assertEqual((st, body), (200, {'cancelled': False}))


class TestConfig(TmpRoot):
    def test_defaults_and_limits(self):
        c = H.config({'ROLE': 'llm', 'ENGINE_UNIT': 'gufo'})
        self.assertEqual((c['bind'], c['port'], c['interval_ms'], c['engine_unit']), ('0.0.0.0', 9180, 500, 'gufo.service'))
        self.assertTrue(c['engine_quadlet'].endswith('/.config/containers/systemd/gufo.container'))
        self.assertEqual(c['engine_url'], 'http://127.0.0.1:8080')
        self.assertIsNone(c['engine_router'])
        routed = H.config({'ROLE': 'llm', 'ENGINE_UNIT': 'gufo', 'ENGINE_ROUTER_URL': 'http://127.0.0.1:8080',
                           'ENGINE_ROUTER_MODEL': 'qwen3.8-flash-next'})
        self.assertEqual(routed['engine_router'], ('http://127.0.0.1:8080', 'qwen3.8-flash-next'))
        with self.assertRaises(SystemExit):
            H.config({'ROLE': 'llm', 'ENGINE_UNIT': 'gufo', 'ENGINE_ROUTER_URL': 'http://127.0.0.1:8080'})
        self.assertEqual(H.config({'ROLE': 'portal', 'ENGINE_UNIT': 'gufo.service'})['engine_unit'], '')
        self.assertEqual(H.config({})['bind'], '127.0.0.1')
        for bad in [{'INTERVAL_MS': '100'}, {'INTERVAL_MS': '6000'}, {'ROLE': 'x'}, {'PORT': '0'}]:
            with self.assertRaises(SystemExit):
                H.config(bad)

    def test_token(self):
        p = os.path.join(self.root, 'token')
        with open(p, 'w') as f:
            f.write('short\n')
        env = dict(os.environ)
        try:
            os.environ.pop('CREDENTIALS_DIRECTORY', None)
            os.environ['HOSTD_TOKEN_FILE'] = p
            with self.assertRaises(SystemExit):
                H.load_token()
            with open(p, 'w') as f:
                f.write('f' * 64 + '\n')
            self.assertEqual(H.load_token(), 'f' * 64)
            os.environ['CREDENTIALS_DIRECTORY'] = self.root
            self.assertEqual(H.load_token(), 'f' * 64)
        finally:
            os.environ.clear()
            os.environ.update(env)


STUBS = {
    # systemctl: log every call; restart marks the unit active
    'systemctl': r"""#!/bin/bash
echo "systemctl $*" >>"$STUB_STATE/log"
case $1 in
    is-active) [[ -e $STUB_STATE/active ]]; exit ;;
    restart) touch "$STUB_STATE/active" ;;
    disable) rm -f "$STUB_STATE/active" ;;
esac
exit 0
""",
    'firewall-cmd': r"""#!/bin/bash
echo "firewall-cmd $*" >>"$STUB_STATE/log"
touch "$STUB_STATE/rules"
for a in "$@"; do
    case $a in
        --state | --reload) exit 0 ;;
        --get-zones | --get-default-zone | --get-zone-of-interface=*) echo FedoraServer; exit 0 ;;
        --query-rich-rule=*) grep -qxF "${a#*=}" "$STUB_STATE/rules"; exit ;;
        --add-rich-rule=*) echo "${a#*=}" >>"$STUB_STATE/rules"; exit 0 ;;
        --remove-rich-rule=*) grep -vxF "${a#*=}" "$STUB_STATE/rules" >"$STUB_STATE/rules.n"; mv "$STUB_STATE/rules.n" "$STUB_STATE/rules"; exit 0 ;;
    esac
done
exit 0
""",
    'ip': '#!/bin/bash\necho "$4 via 192.168.10.1 dev eth0 src 192.168.10.14 uid 0"\n',
    'restorecon': '#!/bin/bash\nexit 0\n',
    'journalctl': '#!/bin/bash\nexit 0\n',
}


def _userns_ok():
    if not shutil.which('unshare') or not shutil.which('bash'):
        return False
    try:
        return subprocess.run(['unshare', '-r', 'true'], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


class _Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == '/v1/health' else 404)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def log_message(self, *a):
        pass


@unittest.skipUnless(_userns_ok(), 'needs unprivileged user namespaces (unshare -r)')
class TestInstaller(TmpRoot):
    """install.sh under `unshare -r` (fake root), with HOSTD_TEST_PREFIX and stub systemctl/firewall-cmd/ip."""

    def setUp(self):
        super().setUp()
        self.src = os.path.join(self.root, 'src')
        os.makedirs(self.src)
        for f in ('install.sh', 'portal-hostd.py', 'portal-hostd.service', 'README.md'):
            if os.path.exists(os.path.join(HERE, f)):
                shutil.copy(os.path.join(HERE, f), self.src)
        self.bin = os.path.join(self.root, 'bin')
        self.state = os.path.join(self.root, 'state')
        self.prefix = os.path.join(self.root, 'prefix')
        os.makedirs(self.bin)
        os.makedirs(self.state)
        for name, body in STUBS.items():
            path = os.path.join(self.bin, name)
            with open(path, 'w') as f:
                f.write(body)
            os.chmod(path, 0o755)
        self.health = http.server.HTTPServer(('127.0.0.1', 0), _Health)
        self.port = self.health.server_address[1]
        threading.Thread(target=self.health.serve_forever, daemon=True).start()

    def tearDown(self):
        self.health.shutdown()
        self.health.server_close()
        super().tearDown()

    def run_install(self, *args, stdin=''):
        env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ.get('PATH', '/usr/bin'),
                   STUB_STATE=self.state, HOSTD_TEST_PREFIX=self.prefix)
        env.pop('SUDO_USER', None)
        return subprocess.run(['unshare', '-r', 'bash', os.path.join(self.src, 'install.sh'), *args],
                              input=stdin, capture_output=True, text=True, env=env, timeout=60)

    def restarts(self):
        try:
            with open(os.path.join(self.state, 'log')) as f:
                return sum(1 for line in f if line.startswith('systemctl restart'))
        except FileNotFoundError:
            return 0

    def read(self, rel):
        with open(os.path.join(self.prefix, rel)) as f:
            return f.read()

    def test_portal_token_stdin_and_idempotent_rerun(self):
        tok = 'e' * 64
        r = self.run_install('portal', '--token-stdin', '--port', str(self.port), stdin=f'  {tok}  \n')
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertNotIn(tok, r.stdout + r.stderr)
        self.assertEqual(self.read('etc/portal-hostd/token'), tok + '\n')
        self.assertEqual(os.stat(os.path.join(self.prefix, 'etc/portal-hostd/token')).st_mode & 0o777, 0o600)
        conf = self.read('etc/portal-hostd/hostd.conf')
        for line in ('ROLE=portal', 'BIND=127.0.0.1', f'PORT={self.port}', 'INTERVAL_MS=500'):
            self.assertIn(line + '\n', conf)
        self.assertNotIn('FIREWALL_SOURCE', conf)
        unit = self.read('etc/systemd/system/portal-hostd.service')
        self.assertNotIn('@', unit.split('[Service]')[1].split('ExecStart')[0] + unit.split('Restart=')[1])
        for line in ('DynamicUser=yes', 'ProtectHome=yes', 'Description=Portal host daemon (portal role)',
                     'After=network-online.target\n', 'LoadCredential=token:/etc/portal-hostd/token'):
            self.assertIn(line, unit)
        self.assertEqual(self.restarts(), 1)
        self.assertTrue(os.path.exists(os.path.join(self.prefix, 'usr/local/lib/portal-hostd/portal-hostd.py')))

        # same token again, as a line that ends CR LF: nothing changes, no restart
        r = self.run_install('portal', '--token-stdin', '--port', str(self.port), stdin=tok + '\r\n')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('unchanged and running', r.stdout)
        self.assertEqual(self.restarts(), 1)
        # no --token-stdin: the stored token is kept, still no restart
        r = self.run_install('portal', '--port', str(self.port))
        self.assertEqual((r.returncode, self.restarts()), (0, 1), r.stderr)
        self.assertEqual(self.read('etc/portal-hostd/token'), tok + '\n')
        # a new token restarts
        r = self.run_install('portal', '--token-stdin', '--port', str(self.port), stdin='f' * 40)
        self.assertEqual((r.returncode, self.restarts()), (0, 2), r.stderr)
        # a changed daemon restarts
        with open(os.path.join(self.src, 'portal-hostd.py'), 'a') as f:
            f.write('\n# changed\n')
        r = self.run_install('portal', '--port', str(self.port))
        self.assertEqual((r.returncode, self.restarts()), (0, 3), r.stderr)
        # a stopped unit is started even when nothing changed
        os.unlink(os.path.join(self.state, 'active'))
        r = self.run_install('portal', '--port', str(self.port))
        self.assertEqual((r.returncode, self.restarts()), (0, 4), r.stderr)

    def test_bad_tokens_refused(self):
        for stdin in ('short\n', 'a' * 20 + ' ' + 'b' * 20 + '\n', ''):
            r = self.run_install('portal', '--token-stdin', '--port', str(self.port), stdin=stdin)
            self.assertNotEqual(r.returncode, 0, stdin)
            self.assertIn('--token-stdin', r.stderr)
        r = self.run_install('portal', '--token', 'x' * 64, '--port', str(self.port))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('unknown option --token', r.stderr)
        self.assertEqual(self.restarts(), 0)
        self.assertFalse(os.path.exists(os.path.join(self.prefix, 'etc/portal-hostd/hostd.conf')))

    def test_generated_token_when_none(self):
        r = self.run_install('portal', '--port', str(self.port))
        self.assertEqual(r.returncode, 0, r.stderr)
        tok = self.read('etc/portal-hostd/token').strip()
        self.assertRegex(tok, r'^[0-9a-f]{64}$')

    def test_llm_without_engine_firewall_and_uninstall(self):
        r = self.run_install('llm', '--portal', '192.168.10.11', '--engine-unit', 'none', '--port', str(self.port))
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        tok = self.read('etc/portal-hostd/token').strip()
        self.assertIn(f'HOSTD_LLM_URL=http://192.168.10.14:{self.port}\n', r.stdout)
        self.assertIn(f'HOSTD_LLM_TOKEN={tok}\n', r.stdout)   # generated here, so it is shown once
        conf = self.read('etc/portal-hostd/hostd.conf')
        self.assertIn('BIND=0.0.0.0\n', conf)
        self.assertIn('FIREWALL_SOURCE=192.168.10.11\n', conf)
        self.assertNotIn('ENGINE_UNIT', conf)
        rule = f'rule family="ipv4" source address="192.168.10.11/32" port port="{self.port}" protocol="tcp" accept'
        with open(os.path.join(self.state, 'rules')) as f:
            self.assertEqual(f.read(), rule + '\n')
        unit = self.read('etc/systemd/system/portal-hostd.service')
        self.assertIn('DynamicUser=yes', unit)   # no engine: no need for the engine user's identity
        # re-run: the rule is not added twice, no restart
        r = self.run_install('llm', '--portal', '192.168.10.11', '--engine-unit', 'none', '--port', str(self.port))
        self.assertEqual((r.returncode, self.restarts()), (0, 1), r.stderr)
        with open(os.path.join(self.state, 'rules')) as f:
            self.assertEqual(f.read().count(rule), 1)
        # a token passed on stdin is not echoed
        r = self.run_install('llm', '--portal', '192.168.10.11', '--engine-unit', 'none', '--port', str(self.port),
                             '--token-stdin', stdin=tok + '\n')
        self.assertNotIn(tok, r.stdout + r.stderr)
        self.assertEqual(self.restarts(), 1)
        # uninstall removes files and the rule
        r = self.run_install('uninstall')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.prefix, 'etc/portal-hostd')))
        self.assertFalse(os.path.exists(os.path.join(self.prefix, 'usr/local/lib/portal-hostd')))
        self.assertFalse(os.path.exists(os.path.join(self.prefix, 'etc/systemd/system/portal-hostd.service')))
        with open(os.path.join(self.state, 'rules')) as f:
            self.assertEqual(f.read(), '')


if __name__ == '__main__':
    unittest.main()
