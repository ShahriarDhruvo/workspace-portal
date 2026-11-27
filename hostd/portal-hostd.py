#!/usr/bin/python3
"""portal-hostd: this host's live hardware readings for the workspace portal's gateway and, in the llm role,
updates of the LLM engine (a rootless Podman quadlet) through the engine user's systemd manager.
Standard library only. README.md has the configuration, the API and the data sources."""

import glob
import hmac
import http.server
import json
import os
import pwd
import re
import secrets
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque

DEFAULT_PORT = 9180
MAX_CONNECTIONS = 16
MAX_STREAMS = 4
MAX_BODY = 4096
HEADER_TIMEOUT = 10.0
KEEPALIVE_AFTER_SAMPLE = 5.0
PERF_LINGER = 30.0
FAN_PERIOD = 3.0
ENGINE_LOG_LINES = 10   # the engine's last log lines a failed apply's error carries: why it did not start
BUSY_PCT = 1.0          # a logical CPU counts as busy (for clock averages) above this usage
PING_EVERY = 15.0
STATUS_CACHE = 5.0
METER_PERIOD = 2.0
SPACE_PERIOD = 5.0      # filesystem space is measured at most this often
SECTOR = 512            # /proc/diskstats counts 512-byte sectors, whatever the disk's block size


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def now_ms():
    return int(time.time() * 1000)


class Fs:
    """Paths under an optional ROOT prefix, so tests can point the daemon at fixture trees."""

    def __init__(self, root=''):
        self.root = root.rstrip('/')

    def p(self, path):
        return self.root + path

    def text(self, path):
        try:
            with open(self.p(path), 'rb') as f:
                return f.read().decode('utf-8', 'replace')
        except OSError:
            return None

    def int(self, path):
        try:
            return int(self.text(path) or '', 0)
        except ValueError:
            return None

    def glob(self, pattern):
        n = len(self.root)
        return [g[n:] for g in sorted(glob.glob(self.p(pattern)))]

    def exists(self, path):
        return os.path.exists(self.p(path))

    def readlink(self, path):
        try:
            return os.readlink(self.p(path))
        except OSError:
            return None


class Src:
    """A file kept open and re-read with pread at offset 0 (sysfs/procfs regenerate on every read)."""

    __slots__ = ('path', 'fd', 'size')

    def __init__(self, path, size):
        self.path, self.fd, self.size = path, None, size

    def read(self):
        for _ in range(2):      # after an error, once more with the file opened again
            try:
                if self.fd is None:
                    self.fd = os.open(self.path, os.O_RDONLY | os.O_CLOEXEC)
                data = b''
                while True:     # to the end: procfs hands out about a page per read, whatever the size asked for
                    chunk = os.pread(self.fd, self.size, len(data))
                    if not chunk:
                        return data
                    data += chunk
            except OSError:
                self.close()
        return None

    def int(self):
        data = self.read()
        try:
            return int(data) if data else None
        except ValueError:
            return None

    def close(self):
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None


class PerfUnavailable(Exception):
    pass


_libc = None


def perf_event_open(type_, config, config1, config2, cpu, group_fd):
    global _libc
    import ctypes
    if os.uname().machine != 'x86_64':      # 298 below is its perf_event_open
        raise OSError(38, 'perf_event_open: unsupported architecture')
    if _libc is None:
        _libc = ctypes.CDLL(None, use_errno=True)
        _libc.syscall.restype = ctypes.c_long
    # struct perf_event_attr, PERF_ATTR_SIZE_VER1 (72 bytes): read_format = GROUP|TOTAL_TIME_ENABLED|RUNNING
    attr = struct.pack('<IIQQQQQIIQQ', type_, 72, config, 0, 0, 8 | 1 | 2, 0, 0, 0, config1, config2)
    buf = ctypes.create_string_buffer(attr, 72)
    fd = _libc.syscall(ctypes.c_long(298), buf, ctypes.c_int(-1), ctypes.c_int(cpu), ctypes.c_int(group_fd),
                       ctypes.c_ulong(8))  # PERF_FLAG_FD_CLOEXEC
    if fd < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    return fd


def pmu_dir(pmu):
    return '/sys/bus/event_source/devices/' + pmu


def pmu_encode(fs, pmu, spec):
    """'event=0x1f,umask=0xffe' -> {'config':..,'config1':..,'config2':..} using <pmu>/format/* bit layouts."""
    regs = {'config': 0, 'config1': 0, 'config2': 0}
    for item in filter(None, (s.strip() for s in spec.split(','))):
        key, _, val = item.partition('=')
        v = int(val, 0) if val else 1
        if key in regs:
            regs[key] |= v
            continue
        fmt = fs.text(pmu_dir(pmu) + '/format/' + key)
        if fmt is None:
            raise PerfUnavailable(f'{pmu}: no format field {key}')
        reg, _, ranges = fmt.strip().partition(':')
        if reg not in regs:
            raise PerfUnavailable(f'{pmu}: unsupported format register {reg}')
        for r in ranges.split(','):
            lo, _, hi = r.partition('-')
            lo = int(lo)
            hi = int(hi) if hi else lo
            width = hi - lo + 1
            regs[reg] |= (v & ((1 << width) - 1)) << lo
            v >>= width
        if v:
            raise PerfUnavailable(f'{pmu}: value too wide for {key}')
    return regs


def pmu_event(fs, pmu, name):
    """Named event from <pmu>/events/<name> -> (spec string, scale)."""
    spec = fs.text(pmu_dir(pmu) + '/events/' + name)
    if spec is None:
        raise PerfUnavailable(f'{pmu}: no event {name}')
    sc = fs.text(pmu_dir(pmu) + '/events/' + name + '.scale')
    try:
        scale = float(sc) if sc else 1.0
    except ValueError:
        scale = 1.0
    return spec.strip(), scale


def rapl_events(fs, labels):
    """The RAPL PMU's energy events among labels (pkg, ram, cores, gpu) -> [(label, spec, joules per count)].
    PerfUnavailable without the package's."""
    evs = []
    for label in labels:
        try:
            evs.append((label, *pmu_event(fs, 'power', 'energy-' + label)))
        except PerfUnavailable:
            if label == 'pkg':
                raise
    return evs


def cpu_list(text):
    """A sysfs CPU list ("0-15", "0,2,4-7") -> [CPU numbers]."""
    out = []
    for part in filter(None, (text or '').strip().split(',')):
        lo, _, hi = part.partition('-')
        out.extend(range(int(lo), int(hi or lo) + 1))
    return out


class PerfGroup:
    """One perf group (all events on one PMU), read with a single read() syscall. events: [(label, spec,
    factor)], where the factor converts a count into the reported unit. cpu: where it counts; default the first
    CPU of the PMU's cpumask."""

    def __init__(self, fs, pmu, events, cpu=None):
        base = pmu_dir(pmu)
        t = fs.int(base + '/type')
        if t is None:
            raise PerfUnavailable(f'no PMU {pmu}')
        mask = cpu_list(fs.text(base + '/cpumask'))
        self.type, self.cpu = t, cpu if cpu is not None else mask[0] if mask else 0
        self.labels = [e[0] for e in events]
        self.factors = [e[2] for e in events]
        self.configs = [pmu_encode(fs, pmu, e[1]) for e in events]
        self.fds = []

    def open(self):
        if self.fds:
            return True
        try:
            for c in self.configs:
                fd = perf_event_open(self.type, c['config'], c['config1'], c['config2'], self.cpu,
                                     self.fds[0] if self.fds else -1)
                self.fds.append(fd)
            return True
        except OSError:
            self.close()
            return False

    def read(self):
        """-> (time_enabled_ns, time_running_ns, [counts]) or None."""
        if not self.fds:
            return None
        n = len(self.fds)
        try:
            b = os.read(self.fds[0], 24 + 8 * n)
            nr, en, ru = struct.unpack_from('<QQQ', b)
            return en, ru, list(struct.unpack_from(f'<{nr}Q', b, 24))
        except (OSError, struct.error):
            return None

    def close(self):
        for fd in reversed(self.fds):
            try:
                os.close(fd)
            except OSError:
                pass
        self.fds = []


class PerCpuGroups:
    """The same perf group opened on each of several CPUs, for counters kept per CPU or per core (the msr PMU's,
    which has no cpumask; power_core's, one CPU of each core in its cpumask). read() -> one reading (or None) per
    CPU, in order."""

    def __init__(self, fs, pmu, events, cpus):
        self.groups = [PerfGroup(fs, pmu, events, cpu) for cpu in cpus]
        if not self.groups:
            raise PerfUnavailable(f'{pmu}: no CPUs')

    def open(self):
        if all(g.open() for g in self.groups):
            return True
        self.close()
        return False

    def read(self):
        return [g.read() for g in self.groups]

    def close(self):
        for g in self.groups:
            g.close()


def busy_clocks(prev, cur, usage):
    """From per-CPU readings of the msr PMU's tsc, aperf and mperf: each CPU's average clock in MHz while it ran
    since the last reading (TSC rate x aperf/mperf, turbostat's Bzy_MHz), for the CPUs more than BUSY_PCT busy,
    and their average weighted by the time each ran. -> ([MHz or None per CPU], MHz or None)."""
    mhz, num, den = [None] * len(usage), 0.0, 0
    for i, (p, c, u) in enumerate(zip(prev or [], cur or [], usage)):
        if p is None or c is None or u is None or u <= BUSY_PCT:
            continue
        ns = c[0] - p[0]
        tsc, aperf, mperf = (b - a for a, b in zip(p[2], c[2]))
        if ns > 0 and tsc > 0 and mperf > 0:
            mhz[i] = round(tsc / ns * 1000 * aperf / mperf)
            num += tsc / ns * 1000 * aperf
            den += mperf
    return mhz, round(num / den) if den else None


def perf_rates(group, prev, cur, dt):
    """Per-event rates (count*factor per second), corrected for multiplexing; None when unknown."""
    if group is None or prev is None or cur is None or not dt or dt <= 0:
        return None
    den, run = cur[0] - prev[0], cur[1] - prev[1]
    if run <= 0 or len(cur[2]) != len(prev[2]):
        return None
    corr = den / run if den > run else 1.0
    return [max(0, c - p) * corr * f / dt for p, c, f in zip(prev[2], cur[2], group.factors)]


GM_V3_SIZE = 264


def decode_gpu_metrics(b):
    """The fields read here of struct gpu_metrics_v3_0 (kgd_pp_interface.h: format 3, content 0, 264 bytes), or
    None for any other revision. Temperatures are centi-degrees C, powers mW, clocks MHz."""
    if not b or len(b) < GM_V3_SIZE:
        return None
    size, fmt, content = struct.unpack_from('<HBB', b, 0)
    if (fmt, content) != (3, 0) or size < GM_V3_SIZE:
        return None

    def field(fmt, off):    # all bits set: the firmware has no value
        x, = struct.unpack_from(fmt, b, off)
        return None if x == (1 << 8 * struct.calcsize(fmt)) - 1 else x

    return {
        'temperature_gfx': field('<H', 4), 'average_gfx_activity': field('<H', 42),
        'average_socket_power': field('<I', 112), 'average_gfx_power': field('<I', 124),
        'average_all_core_power': field('<I', 132), 'average_gfxclk_frequency': field('<H', 174),
        'current_gfx_maxfreq': field('<H', 224), 'throttle': struct.unpack_from('<7I', b, 228),
    }


def pci_name(fs, vendor, device):
    """Device name from pci.ids (vendor/device as 4-digit lowercase hex), or None. Read line by line:
    memory once allocated for the whole file would stay in the RSS."""
    try:
        f = open(fs.p('/usr/share/hwdata/pci.ids'), encoding='utf-8', errors='replace')
    except OSError:
        return None
    with f:
        in_vendor = False
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            if line[0] != '\t':
                if in_vendor:
                    return None
                in_vendor = line[:4].lower() == vendor
            elif in_vendor and line[1] != '\t' and line[1:5].lower() == device:
                return line[5:].strip()
    return None


def gpu_display_name(fs, card_dev, kind, cpu_model):
    vendor = (fs.text(card_dev + '/vendor') or '').strip().lower().replace('0x', '')
    device = (fs.text(card_dev + '/device') or '').strip().lower().replace('0x', '')
    name = pci_name(fs, vendor, device) if vendor and device else None
    fallback = 'AMD GPU' if kind == 'amdgpu' else 'Intel GPU'
    if not name:
        return fallback
    inner = re.search(r'\[(.+)\]', name)
    choices = [c.strip() for c in inner.group(1).split('/')] if inner else []
    # APUs: the CPU brand string names the exact iGPU ("... w/ Radeon 8060S"); prefer it when pci.ids agrees
    m = re.search(r'\bw/\s*(.+)$', cpu_model or '')
    if m and m.group(1).strip():
        cand = m.group(1).strip()
        last = cand.split()[-1]
        if cand.lower() in name.lower() or re.search(r'(?<![\w])' + re.escape(last) + r'(?![\w])', name, re.I):
            return cand
    if len(choices) == 1:
        name = choices[0]
    if kind == 'i915' and not name.lower().startswith('intel'):
        name = 'Intel ' + name
    return name


class AmdGpu:
    def __init__(self, fs, dev):
        self.metrics = Src(fs.p(dev + '/gpu_metrics'), 1024)
        self.vram_used = Src(fs.p(dev + '/mem_info_vram_used'), 64)
        self.vram_total = fs.int(dev + '/mem_info_vram_total')
        gm = self.read()
        self.ok = gm is not None
        self.max_mhz = gm['current_gfx_maxfreq'] if gm else None
        if not self.max_mhz:
            levels = re.findall(r'(\d+)\s*Mhz', fs.text(dev + '/pp_dpm_sclk') or '', re.I)
            self.max_mhz = max(map(int, levels)) if levels else None

    def read(self):
        return decode_gpu_metrics(self.metrics.read())


class IntelGpu:
    def __init__(self, fs, card):
        self.act = Src(fs.p(card + '/gt_act_freq_mhz'), 64)
        rc6 = card + '/power/rc6_residency_ms'
        if not fs.exists(rc6):
            rc6 = card + '/gt/gt0/rc6_residency_ms'
        self.rc6 = Src(fs.p(rc6), 64) if fs.exists(rc6) else None
        self.max_mhz = fs.int(card + '/gt_RP0_freq_mhz') or fs.int(card + '/gt_max_freq_mhz')


class EcFans:
    """Fans of the Sixunited AXB35 EC driver (ec_su_axb35). Each read is an EC transaction that sleeps, so
    the sampler leaves them to a thread of their own."""

    def __init__(self, fs):
        self.fans = []
        for d in fs.glob('/sys/class/ec_su_axb35/fan[0-9]*'):
            n = re.search(r'fan(\d+)$', d)
            if not n or not fs.exists(d + '/rpm'):
                continue
            duty = Src(fs.p(d + '/duty'), 64) if fs.exists(d + '/duty') else None
            self.fans.append(('Fan ' + n.group(1), Src(fs.p(d + '/rpm'), 64), duty))
        self.fans.sort(key=lambda f: int(f[0].split()[1]))

    def read(self):
        return [{'label': label, 'rpm': rpm.int(), 'duty': duty.int() if duty else None}
                for label, rpm, duty in self.fans]

    def empty(self):
        return [{'label': label, 'rpm': None, 'duty': None} for label, _, _ in self.fans]


def counter_rates(prev, cur, dt, unit=1):
    """Per-second increase of two counters summed over the names in both readings ({name: (a, b)}), times unit;
    (None, None) without both readings. A counter that went back (a reset) adds nothing; neither does a name
    in only one reading."""
    if prev is None or cur is None or not dt:
        return None, None
    da = db = 0
    for name, (a, b) in cur.items():
        p = prev.get(name)
        if p is not None:
            da += max(0, a - p[0])
            db += max(0, b - p[1])
    return int(da * unit / dt), int(db * unit / dt)


# Counters arguments: the /proc table, where sysfs lists its devices, and the columns of the name and the two
# counters (a ':' counts as a space).
NET = ('/proc/net/dev', '/sys/class/net/', 0, 1, 9)         # bytes received and sent
DISKS = ('/proc/diskstats', '/sys/block/', 2, 5, 9)         # sectors read and written


class Counters:
    """Two counters per device of a /proc table, for the devices with hardware behind them (a `device` link in
    sysfs). That leaves out lo, bridges, veth pairs and tunnels, and partitions, loop, zram, device-mapper and
    md devices: what they carry a real device counts too, or it never leaves the host."""

    def __init__(self, fs, table, sysfs, name, a, b):
        self.fs, self.sysfs, self.columns = fs, sysfs, (name, a, b)
        self.src = Src(fs.p(table), 16384)
        self._real = {}       # name -> bool, for the names of the last reading (veths come and go)

    def read(self):
        """{name: (a, b)}, or None without the table or any such device."""
        data = self.src.read()
        if not data:
            return None
        name_at, a, b = self.columns
        seen, out = {}, {}
        for line in data.decode('ascii', 'replace').replace(':', ' ').splitlines():
            f = line.split()
            if len(f) <= b:
                continue
            name = f[name_at]
            real = self._real.get(name)
            if real is None:
                real = self.fs.exists(self.sysfs + name.replace('/', '!') + '/device')
            seen[name] = real
            if real:
                try:
                    out[name] = (int(f[a]), int(f[b]))
                except ValueError:
                    pass
        self._real = seen
        return out or None


def _unescape(field):
    """A /proc/self/mounts field, whose spaces, tabs, newlines and backslashes are escaped as \\ooo."""
    return re.sub(r'\\([0-7]{3})', lambda m: chr(int(m.group(1), 8)), field)


def local_filesystems(mounts):
    """(source, mount point) of the filesystems on local block devices in /proc/self/mounts text, one per source
    (btrfs subvolumes and bind mounts share theirs), in mount order. A mount covered by a later one at or above
    its mount point is left out: statvfs there would measure the cover (ProtectHome's empty tmpfs over /home)."""
    entries = []
    for line in mounts.splitlines():
        f = line.split()
        if len(f) >= 2:
            entries.append((_unescape(f[0]), _unescape(f[1])))
    covered, found = set(), []
    for source, point in reversed(entries):
        p = point
        while p not in covered and p != '/' and p:
            p = os.path.dirname(p)
        visible = p not in covered
        covered.add(point)
        if visible and source.startswith('/dev/') and not source.startswith(('/dev/loop', '/dev/zram', '/dev/ram')):
            found.append((source, point))
    seen, out = set(), []
    for source, point in reversed(found):
        if source not in seen:
            seen.add(source)
            out.append((source, point))
    return out


class FsSpace:
    """Size and free space of the local filesystems together. statvfs on a failing disk can hang, so after the
    first measurement each refresh runs in a thread of its own and get() answers at once with the last result."""

    def __init__(self, fs, period=SPACE_PERIOD, statvfs=os.statvfs):
        self.fs, self.period, self.statvfs = fs, period, statvfs
        self.lock = threading.Lock()
        self.value, self.mounts = None, []
        self.running = False
        self.started = time.monotonic()
        self.refresh()

    def get(self):
        """(total_bytes, free_bytes), or None when no local filesystem could be measured."""
        with self.lock:
            if not self.running and time.monotonic() - self.started >= self.period:
                self.running, self.started = True, time.monotonic()
                threading.Thread(target=self.refresh, name='space', daemon=True).start()
            return self.value

    def refresh(self):
        total = free = 0
        mounts = []
        try:
            for _, point in local_filesystems(self.fs.text('/proc/self/mounts') or ''):
                try:
                    st = self.statvfs(self.fs.p(point))
                except OSError:
                    continue
                total += st.f_blocks * st.f_frsize
                free += st.f_bavail * st.f_frsize
                mounts.append(point)
        finally:
            with self.lock:
                self.value = (total, free) if mounts else None
                self.mounts = mounts
                self.running = False


def r1(x):
    return None if x is None else round(x, 1)


def r2(x, per=1):
    return None if x is None else round(x / per, 2)


class Host:
    def __init__(self, fs, role, interval_ms, engine_unit=None):
        self.fs, self.role, self.interval_ms, self.engine_unit = fs, role, interval_ms, engine_unit
        self.stat = Src(fs.p('/proc/stat'), 65536)
        self.meminfo = Src(fs.p('/proc/meminfo'), 8192)
        self.ncpu = len(re.findall(r'^cpu\d+\s', fs.text('/proc/stat') or '', re.M)) or os.cpu_count() or 1
        self.cpu_model, self.cores, self.threads = self._cpuinfo()
        maxes = [m for i in range(self.ncpu) if (m := fs.int(f'/sys/devices/system/cpu/cpu{i}/cpufreq/cpuinfo_max_freq'))]
        self.cpu_max_mhz = max(maxes) // 1000 if maxes else None
        self.cpu_temp = self._cpu_temp()
        self.gpu, self.gpu_name = self._gpu()
        self.amd = isinstance(self.gpu, AmdGpu)
        self.fans = EcFans(fs)
        self.net = Counters(fs, *NET)
        self.disks = Counters(fs, *DISKS)
        self.space = FsSpace(fs)
        self.groups = self._perf_groups()   # name -> PerfGroup, open while the sampler runs
        self.perf_ok = bool(self.groups)
        self.perf_open = False
        self.perf_gen = 0
        self._info = None

    def _cpuinfo(self):
        data = self.fs.text('/proc/cpuinfo') or ''
        model = None
        cores = set()
        threads = 0
        phys = core = None
        for line in data.splitlines() + ['']:
            k, _, v = line.partition(':')
            k, v = k.strip(), v.strip()
            if k == 'processor':
                threads += 1
            elif k == 'model name' and model is None:
                model = v
            elif k == 'physical id':
                phys = v
            elif k == 'core id':
                core = v
            elif not line.strip() and core is not None:
                cores.add((phys, core))
                phys = core = None
        threads = threads or self.ncpu
        return model, len(cores) or threads, threads

    def _cpu_temp(self):
        fs = self.fs
        for h in fs.glob('/sys/class/hwmon/hwmon*'):
            name = (fs.text(h + '/name') or '').strip()
            if name == 'k10temp' and fs.exists(h + '/temp1_input'):
                return Src(fs.p(h + '/temp1_input'), 64)
            if name == 'coretemp':
                for lab in fs.glob(h + '/temp*_label'):
                    if (fs.text(lab) or '').strip().startswith('Package id'):
                        return Src(fs.p(lab[:-len('_label')] + '_input'), 64)
        for z in fs.glob('/sys/class/thermal/thermal_zone*'):
            if (fs.text(z + '/type') or '').strip() == 'x86_pkg_temp':
                return Src(fs.p(z + '/temp'), 64)
        return None

    def _gpu(self):
        fs = self.fs
        for card in fs.glob('/sys/class/drm/card*'):
            if not re.search(r'/card\d+$', card):
                continue
            drv = os.path.basename(fs.readlink(card + '/device/driver') or '')
            if drv == 'amdgpu' and fs.exists(card + '/device/gpu_metrics'):
                g = AmdGpu(fs, card + '/device')
                if g.ok:
                    return g, gpu_display_name(fs, card + '/device', 'amdgpu', self.cpu_model)
            if drv == 'i915' and fs.exists(card + '/gt_act_freq_mhz'):
                return IntelGpu(fs, card), gpu_display_name(fs, card + '/device', 'i915', self.cpu_model)
        return None, None

    def _perf_groups(self):
        """The perf groups this host has and this process may open (CAP_PERFMON)."""
        fs = self.fs
        named = lambda pmu, event: pmu_event(fs, pmu, event)[0]
        wanted = {}     # name -> what builds the group, which raises PerfUnavailable when the host lacks it
        if self.amd:    # RAPL energy of each core: the cores' power
            wanted['cores'] = lambda: PerCpuGroups(fs, 'power_core', [('core', *pmu_event(fs, 'power_core', 'energy-core'))],
                                                   cpu_list(fs.text(pmu_dir('power_core') + '/cpumask')))
        if self.amd:    # Strix Halo data fabric: DRAM channels 0, 4, 8, 12 (of 16) per direction, 64 B per beat, x4
            wanted['df'] = lambda: PerfGroup(fs, 'amd_df', [(f'{rw}{n}', f'event={0x1f + 0x40 * n},umask={umask}', 256.0)
                                                            for rw, umask in (('rd', '0xffe'), ('wr', '0x7ff')) for n in (0, 4, 8, 12)])
        # Intel client IMC: free-running counters of 64-byte lines
        wanted['imc'] = lambda: PerfGroup(fs, 'uncore_imc', [('rd', named('uncore_imc', 'data_reads'), 64.0),
                                                             ('wr', named('uncore_imc', 'data_writes'), 64.0)])
        # RAPL: the package (an APU's is CPU, GPU and the rest of the chip), and on Intel DRAM, cores and GPU
        wanted['rapl'] = lambda: PerfGroup(fs, 'power', rapl_events(fs, ('pkg', 'ram', 'cores', 'gpu')))
        if isinstance(self.gpu, IntelGpu):
            wanted['i915'] = lambda: PerfGroup(fs, 'i915', [('rcs0', named('i915', 'rcs0-busy'), 1.0)])
        wanted['clock'] = lambda: PerCpuGroups(fs, 'msr', [(e, named('msr', e), 1.0) for e in ('tsc', 'aperf', 'mperf')],
                                               range(self.ncpu))
        groups = {}
        for name, build in wanted.items():
            try:
                group = build()
            except PerfUnavailable:
                continue
            if group.open():
                groups[name] = group
            group.close()
        return groups

    def open_perf(self):
        if not self.perf_open:
            for g in self.groups.values():
                g.open()
            self.perf_open = True
            self.perf_gen += 1

    def close_perf(self):
        for g in self.groups.values():
            g.close()
        self.perf_open = False

    def sources(self):
        groups = self.groups
        power = 'rapl' if 'rapl' in groups else 'socket' if self.amd else None
        if self.amd:
            gpu_busy = 'activity'
        else:
            gpu_busy = 'pmu' if 'i915' in groups else 'awake' if self.gpu and self.gpu.rc6 else None
        bw = 'amd_df' if 'df' in groups else 'uncore_imc' if 'imc' in groups else None
        return {'perf': self.perf_ok, 'bandwidth': bw, 'power': power, 'gpuBusy': gpu_busy}

    def info(self):
        if self._info is None:      # all of it but the inventory stays as it is
            m = re.search(r'^PRETTY_NAME="?(.*?)"?$', self.fs.text('/etc/os-release') or '', re.M)
            src = self.sources()
            power_label = {'socket': 'APU socket power', 'rapl': 'APU package (RAPL)' if self.amd else 'CPU package + DRAM (RAPL)'}.get(src['power'])
            self._info = {
                'hostname': socket.gethostname().split('.')[0],
                'role': self.role,
                'os': m.group(1) if m else None,
                'kernel': (self.fs.text('/proc/sys/kernel/osrelease') or os.uname().release).strip(),
                'intervalMs': self.interval_ms,
                'cpu': {'model': self.cpu_model, 'cores': self.cores, 'threads': self.threads,
                        'maxMhz': self.cpu_max_mhz},
                'gpu': {'name': self.gpu_name, 'maxMhz': self.gpu.max_mhz} if self.gpu is not None else None,
                'memory': {'totalBytes': self._meminfo().get('MemTotal', 0) * 1024},
                'sources': src,
                'power': {'label': power_label} if power_label else None,
                'engine': {'unit': self.engine_unit} if self.engine_unit else None,
            }
        return {**self._info, **self.inventory()}

    def inventory(self):
        """What the samples' net and disk count, as it is now: the physical interfaces, the whole disks and the
        mount points of the local filesystems."""
        fs = self.fs
        ifaces = [os.path.basename(d) for d in fs.glob('/sys/class/net/*') if fs.exists(d + '/device')]
        disks = [os.path.basename(d).replace('!', '/') for d in fs.glob('/sys/block/*') if fs.exists(d + '/device')]
        with self.space.lock:
            mounts = list(self.space.mounts)
        return {
            'network': {'interfaces': ifaces} if ifaces else None,
            'disks': {'devices': disks, 'mounts': mounts} if disks or mounts else None,
        }

    def _meminfo(self):
        out = {}
        for line in (self.meminfo.read() or b'').decode('ascii', 'replace').splitlines():
            k, _, v = line.partition(':')
            f = v.split()
            if f:
                try:
                    out[k] = int(f[0])
                except ValueError:
                    pass
        return out

    def _stat(self):
        agg, per = None, {}
        for line in (self.stat.read() or b'').decode('ascii', 'replace').splitlines():
            if not line.startswith('cpu'):
                continue
            f = line.split()
            try:
                v = [int(x) for x in f[1:9]]
            except ValueError:
                continue
            v += [0] * (8 - len(v))
            pair = (sum(v), v[3] + v[4])
            if f[0] == 'cpu':
                agg = pair
            else:
                per[int(f[0][3:])] = pair
        return agg, per

    def read(self):
        raw = {'mono': time.monotonic(), 't': now_ms(), 'gen': self.perf_gen}
        raw['agg'], raw['per'] = self._stat()
        raw['mem'] = self._meminfo()
        raw['temp'] = self.cpu_temp.int() if self.cpu_temp else None
        g = self.gpu
        if self.amd:
            raw['gm'], raw['vram'] = g.read(), g.vram_used.int()
        elif g is not None:
            raw['act'], raw['rc6'] = g.act.int(), g.rc6.int() if g.rc6 else None
        for name, grp in self.groups.items():
            raw['perf_' + name] = grp.read()
        raw['net'] = self.net.read()
        raw['disk'] = self.disks.read()
        raw['space'] = self.space.get()
        return raw

    def compute(self, prev, cur, fans=None):
        """The sample of reading cur; rates are over the time since reading prev and null without it."""
        if prev is not None and prev['gen'] != cur['gen']:      # the perf counters began again at zero
            prev = None
        dt = cur['mono'] - prev['mono'] if prev else None
        n = self.ncpu

        def rates(name):
            return perf_rates(self.groups.get(name), prev and prev.get('perf_' + name), cur.get('perf_' + name), dt)

        def summed(name):   # a PerCpuGroups' first event, added up over its CPUs; None unless all have a rate
            group, a, b = self.groups.get(name), prev and prev.get('perf_' + name), cur.get('perf_' + name)
            if group is None or not a or not b:
                return None
            each = [perf_rates(g, p, c, dt) for g, p, c in zip(group.groups, a, b)]
            return None if any(r is None for r in each) else sum(r[0] for r in each)

        usage, core_usage = None, [None] * n
        if prev and prev['agg'] and cur['agg']:
            dtot, didle = cur['agg'][0] - prev['agg'][0], cur['agg'][1] - prev['agg'][1]
            usage = r1(100.0 * (dtot - didle) / dtot) if dtot > 0 else None
            for i in range(n):
                a, b = prev['per'].get(i), cur['per'].get(i)
                if a and b and b[0] > a[0]:
                    core_usage[i] = r1(min(100.0, max(0.0, 100.0 * ((b[0] - a[0]) - (b[1] - a[1])) / (b[0] - a[0]))))
        core_mhz, mhz = busy_clocks(prev and prev.get('perf_clock'), cur.get('perf_clock'), core_usage)
        temp = r2(cur['temp'], 1000)

        rapl = rates('rapl')
        rapl = dict(zip(self.groups['rapl'].labels, rapl)) if rapl else {}
        watts = r2(rapl['pkg'] + rapl.get('ram', 0.0)) if 'pkg' in rapl else None
        dram = r2(rapl.get('ram'))
        gpu = throttling = None
        if self.amd:
            gm = cur['gm'] or {}
            act = gm.get('average_gfx_activity')
            cpu_power, gpu_power = r2(summed('cores')), r2(gm.get('average_gfx_power'), 1000)
            # no perf: the firmware's own figures in gpu_metrics, the same within 0.1% under a steady load
            if 'cores' not in self.groups:
                cpu_power = r2(gm.get('average_all_core_power'), 1000)
            if 'rapl' not in self.groups:
                watts = r2(gm.get('average_socket_power'), 1000)
            gpu = {'usage': act if act is not None and act <= 100 else None, 'mhz': gm.get('average_gfxclk_frequency'),
                   'tempC': r2(gm.get('temperature_gfx'), 100), 'powerW': gpu_power,
                   'memUsedBytes': cur['vram'], 'memTotalBytes': self.gpu.vram_total}
            if gm and prev and prev['gm']:
                throttling = any(c > p for p, c in zip(prev['gm']['throttle'], gm['throttle']))
        else:
            cpu_power, gpu_power = r2(rapl.get('cores')), r2(rapl.get('gpu'))
            if self.gpu is not None:
                busy, i915 = None, rates('i915')
                if i915:
                    busy = r1(min(100.0, i915[0] / 1e9 * 100.0))
                elif dt and cur['rc6'] is not None and prev['rc6'] is not None:     # without the PMU: the time not in RC6
                    busy = r1(min(100.0, max(0.0, 100.0 - 100.0 * (cur['rc6'] - prev['rc6']) / (dt * 1000.0))))
                gpu = {'usage': busy, 'mhz': cur['act'], 'tempC': temp, 'powerW': gpu_power,
                       'memUsedBytes': None, 'memTotalBytes': None}

        bw = rates('df') or rates('imc') or []
        half = len(bw) // 2     # either group: its read counters, then as many write counters
        rx, tx = counter_rates(prev and prev['net'], cur['net'], dt)
        rd, wr = counter_rates(prev and prev['disk'], cur['disk'], dt, SECTOR)
        space = cur['space'] or (None, None)
        mem = cur['mem']
        total, avail = mem.get('MemTotal', 0) * 1024, mem.get('MemAvailable', 0) * 1024
        return {
            't': cur['t'],
            'cpu': {'usage': usage, 'mhz': mhz,
                    'mhzPeak': max((m for m in core_mhz if m is not None), default=None), 'tempC': temp,
                    'powerW': cpu_power, 'coreUsage': core_usage, 'coreMhz': core_mhz},
            'gpu': gpu,
            'memory': {'totalBytes': total, 'availableBytes': avail, 'usedBytes': max(0, total - avail),
                       'gpuBytes': mem['GPUActive'] * 1024 if self.amd and 'GPUActive' in mem else None,
                       'swapTotalBytes': mem.get('SwapTotal', 0) * 1024,
                       'swapUsedBytes': max(0, mem.get('SwapTotal', 0) - mem.get('SwapFree', 0)) * 1024,
                       'readBps': int(sum(bw[:half])) if bw else None,
                       'writeBps': int(sum(bw[half:])) if bw else None},
            'power': {'watts': watts, 'parts': {'gpu': gpu_power, 'cpu': cpu_power, 'dram': dram}},
            'fans': fans if fans is not None else self.fans.empty(),
            'throttling': throttling,
            'net': {'rxBps': rx, 'txBps': tx} if cur['net'] is not None else None,
            'disk': {'readBps': rd, 'writeBps': wr, 'totalBytes': space[0], 'freeBytes': space[1]}
                    if cur['disk'] is not None or cur['space'] is not None else None,
        }


class Sampler:
    """One shared sampling thread; runs only while a stream is open or for a few seconds after /v1/sample."""

    def __init__(self, host, interval_s, keepalive=KEEPALIVE_AFTER_SAMPLE, perf_linger=PERF_LINGER,
                 fan_period=FAN_PERIOD):
        self.host, self.interval = host, interval_s
        self.keepalive, self.perf_linger, self.fan_period = keepalive, perf_linger, fan_period
        self.cond = threading.Condition()
        self.streams = 0
        self.keep_until = 0.0
        self.latest = None
        self.latest_mono = 0.0
        self.seq = 0
        self.fan_values = None
        self.stopping = False
        self._thread = threading.Thread(target=self._run, name='sampler', daemon=True)
        self._fan_thread = threading.Thread(target=self._fans, name='fans', daemon=True) if host.fans.fans else None

    def start(self):
        self._thread.start()
        if self._fan_thread:
            self._fan_thread.start()

    def stop(self):
        with self.cond:
            self.stopping = True
            self.cond.notify_all()

    def _active(self):
        return self.streams > 0 or time.monotonic() < self.keep_until

    def add_stream(self):
        with self.cond:
            if self.streams >= MAX_STREAMS:
                return False
            self.streams += 1
            self.cond.notify_all()
            return True

    def remove_stream(self):
        with self.cond:
            self.streams = max(0, self.streams - 1)
            self.cond.notify_all()

    def wait_newer(self, seq, timeout):
        """Newest sample with a sequence number above seq -> (seq, sample), or (seq, None) on timeout."""
        deadline = time.monotonic() + timeout
        with self.cond:
            while (self.seq <= seq or self.latest is None) and not self.stopping:
                left = deadline - time.monotonic()
                if left <= 0:
                    return seq, None
                self.cond.wait(left)
            return (self.seq, self.latest) if self.latest is not None else (seq, None)

    def current(self):
        """A fresh sample for /v1/sample: the latest if recent, else the next one. Keeps the sampler running
        for `keepalive` seconds."""
        with self.cond:
            self.keep_until = time.monotonic() + self.keepalive
            self.cond.notify_all()
            if self.latest is not None and time.monotonic() - self.latest_mono < 1.5 * self.interval:
                return self.latest
            seq = self.seq
        return self.wait_newer(seq, 3.0)[1]

    def _run(self):
        prev = None
        while True:
            with self.cond:
                idle_since = None
                while not self._active() and not self.stopping:
                    prev = None
                    self.latest = None
                    if self.host.perf_open:
                        t = time.monotonic()
                        if idle_since is None:
                            idle_since = t
                        left = idle_since + self.perf_linger - t
                        if left <= 0:
                            self.host.close_perf()
                            continue
                        self.cond.wait(left)
                    else:
                        self.cond.wait()
                if self.stopping:
                    return
            t0 = time.monotonic()
            try:
                self.host.open_perf()
                cur = self.host.read()
                sample = self.host.compute(prev, cur, self.fan_values)
                prev = cur
            except Exception as e:  # never let one bad reading kill the sampler
                log(f'sampler: {type(e).__name__}: {e}')
                sample = None
            with self.cond:
                if sample is not None:
                    self.latest, self.latest_mono = sample, time.monotonic()
                    self.seq += 1
                    self.cond.notify_all()
                deadline = t0 + self.interval
                while not self.stopping:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    self.cond.wait(left)

    def _fans(self):
        while True:
            with self.cond:
                while not self._active() and not self.stopping:
                    self.fan_values = None
                    self.cond.wait()
                if self.stopping:
                    return
            values = self.host.fans.read()
            with self.cond:
                self.fan_values = values
                deadline = time.monotonic() + self.fan_period
                while not self.stopping and self._active():
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    self.cond.wait(left)


class Meter:
    """Running totals since this hostd started, for GET /v1/meter, kept whether or not anyone watches: the
    energy behind the samples' power.watts and the bytes on the physical interfaces. Energy is the RAPL package
    (+ DRAM) counters; without them an APU's socket power integrated over time (each gpu_metrics read is a request
    to its power firmware, so only then), else None. The counters are the meter's own and stay open: the sampler's
    perf groups close when nobody watches, and a RAPL counter begins again at zero when opened."""

    def __init__(self, host, period=METER_PERIOD):
        self.instance = secrets.token_hex(8)
        self.started_at = now_ms()
        self.period = period
        self.net = Counters(host.fs, *NET)
        self.gpu_metrics = self.rapl = None
        self._socket = host.gpu.metrics.path if host.amd else None   # the fallback, opened only when needed
        if 'rapl' in host.groups:
            try:
                self.rapl = PerfGroup(host.fs, 'power', rapl_events(host.fs, ('pkg', 'ram')))
            except PerfUnavailable:
                pass
        self.lock = threading.Lock()
        self.energy = None
        self.rx = self.tx = None
        self.t = self.started_at
        self._watts = self._mono = None
        self._links = None            # {name: (rx, tx)}: every physical interface seen, at its last reading
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name='meter', daemon=True)

    def start(self):
        if self.rapl is not None and not self.rapl.open():
            log('meter: cannot open the RAPL counters; ' + ('energy from gpu_metrics' if self._socket else 'energy is not measured'))
            self.rapl = None
        if self.rapl is None and self._socket:
            self.gpu_metrics = Src(self._socket, 1024)
        if self.gpu_metrics is not None or self.rapl is not None:
            self.energy = 0.0
        self.tick()
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self.rapl is not None:
            self.rapl.close()

    def _run(self):
        while not self._stop.wait(self.period):
            try:
                self.tick()
            except Exception as e:  # never let one bad reading stop the meter
                log(f'meter: {type(e).__name__}: {e}')

    def tick(self):
        net = self.net.read()
        mono = time.monotonic()
        with self.lock:
            if self.gpu_metrics is not None:
                gm = decode_gpu_metrics(self.gpu_metrics.read())
                mw = gm['average_socket_power'] if gm else None
                if mw is not None:
                    w = mw / 1000.0
                    if self._watts is not None:     # trapezoid since the last good reading
                        self.energy += (self._watts + w) / 2 * (mono - self._mono)
                    self._watts, self._mono = w, mono
            elif self.rapl is not None:
                r = self.rapl.read()
                if r is not None:
                    self.energy = sum(c * f for c, f in zip(r[2], self.rapl.factors))
            if net is not None:
                if self._links is None:
                    self.rx = self.tx = 0
                else:   # a counter that went back, or an interface that is new, began at zero
                    for name, (rx, tx) in net.items():
                        last = self._links.get(name, (0, 0))
                        self.rx += rx - last[0] if rx >= last[0] else rx
                        self.tx += tx - last[1] if tx >= last[1] else tx
                self._links = {**(self._links or {}), **net}
            self.t = now_ms()

    def snapshot(self):
        with self.lock:
            return {'instance': self.instance, 'startedAt': self.started_at, 't': self.t,
                    'energyJ': None if self.energy is None else round(self.energy, 3),
                    'rxBytes': self.rx, 'txBytes': self.tx}


# The three that check a request, with fullmatch: "$" would let a line break at the end through.
IMAGE_RE = re.compile(r'(?P<repo>[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?'
                      r'(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)+)@(?P<digest>sha256:[0-9a-f]{64})')
DIGEST_RE = re.compile(r'sha256:[0-9a-f]{64}')
VERSION_RE = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+')
IMAGE_LINE_RE = re.compile(r'^(\s*Image\s*=\s*)(.*?)(\s*)$')
DOC_LINE_RE = re.compile(r'^\s*Documentation\s*=')
DOC_VERSION_RE = re.compile(r'/v(\d+\.\d+\.\d+)/')


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class StepError(Exception):
    pass


def repository_of(image):
    ref = image.split('@', 1)[0]
    last = ref.rsplit('/', 1)
    if ':' in last[-1]:
        ref = ref[:len(ref) - len(last[-1])] + last[-1].split(':', 1)[0]
    return ref


def digest_of(image):
    return image.split('@', 1)[1] if image and '@' in image else None


def image_with(images, digest):
    return next((i for i in images if digest in i['digests']), None)


def quadlet_image(text):
    """-> (index of the Image= line, value); StepError unless exactly one Image= line."""
    hits = [(i, m.group(2)) for i, line in enumerate(text.splitlines()) if (m := IMAGE_LINE_RE.match(line))]
    if len(hits) != 1:
        raise StepError(f'quadlet must contain exactly one Image= line (found {len(hits)})')
    return hits[0]


def quadlet_rewrite(text, image, version):
    """Only the Image= value changes (plus a /vX.Y.Z/ Documentation= segment when version is given)."""
    lines = text.splitlines(keepends=True)
    idx, _ = quadlet_image(text)
    body = lines[idx].rstrip('\r\n')
    m = IMAGE_LINE_RE.match(body)
    lines[idx] = m.group(1) + image + m.group(3) + lines[idx][len(body):]
    if version:
        lines = [DOC_VERSION_RE.sub('/v' + version + '/', l) if DOC_LINE_RE.match(l) else l for l in lines]
    return ''.join(lines)


def doc_version(text):
    for line in text.splitlines():
        if DOC_LINE_RE.match(line) and (m := DOC_VERSION_RE.search(line)):
            return m.group(1)
    return None


def atomic_write(path, data, mode=None):
    d, base = os.path.split(path)
    if mode is None:
        try:
            mode = stat.S_IMODE(os.stat(path).st_mode)
        except OSError:
            mode = 0o644
    fd, tmp = tempfile.mkstemp(prefix='.' + base + '.', suffix='.hostd-tmp', dir=d)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fchmod(f.fileno(), mode)
            os.fsync(f.fileno())
        os.rename(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


class Runner:
    """Runs systemctl --user directly and podman only inside the engine user's systemd manager: under
    NoNewPrivileges this service cannot run rootless podman's newuidmap itself."""

    PODMAN = ['systemd-run', '--user', '--wait', '--pipe', '--quiet', '--collect']

    def podman(self, args, unit=None):
        return self.PODMAN + ([f'--unit={unit}'] if unit else []) + ['podman'] + list(args)

    def run(self, argv, timeout):
        try:
            p = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
            return p.returncode, p.stdout.decode('utf-8', 'replace'), p.stderr.decode('utf-8', 'replace')
        except subprocess.TimeoutExpired:
            return 124, '', f'timed out after {timeout:.0f} s'
        except OSError as e:
            return 127, '', str(e)

    def stream(self, argv, on_line, timeout):
        try:
            p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        except OSError as e:
            on_line(str(e))
            return 127
        killer = threading.Timer(timeout, p.kill)
        killer.daemon = True
        killer.start()
        try:
            buf = b''
            while True:
                chunk = p.stdout.read1(4096)
                if not chunk:
                    break
                buf += chunk
                *lines, buf = re.split(rb'[\r\n]', buf)
                for line in lines:
                    if line.strip():
                        on_line(line.decode('utf-8', 'replace').rstrip())
            if buf.strip():
                on_line(buf.decode('utf-8', 'replace').rstrip())
            return p.wait()
        finally:
            killer.cancel()


class Job:
    def __init__(self, kind, image, version):
        self.id = secrets.token_hex(3)
        self.kind, self.image, self.version = kind, image, version
        self.phase, self.step = 'running', 'Starting'
        self.log = deque(maxlen=200)
        self.started_at, self.finished_at = now_ms(), None
        self.error, self.rolled_back = None, False
        self.cancel_requested = False
        self.lock = threading.Lock()

    def add(self, line):
        with self.lock:
            self.log.append(time.strftime('%H:%M:%S ') + line)

    def set_step(self, step):
        self.step = step
        self.add(step)

    def to_json(self):
        with self.lock:
            return {'id': self.id, 'kind': self.kind, 'image': self.image, 'version': self.version,
                    'phase': self.phase, 'step': self.step, 'log': list(self.log),
                    'startedAt': self.started_at, 'finishedAt': self.finished_at,
                    'error': self.error, 'rolledBack': self.rolled_back}


class Router:
    """llama-swap in front of the engine (ENGINE_ROUTER_URL): it starts and stops the engine's units on demand, the
    LLM's and the image models', and never runs both. So a restart goes through it, and an engine unit that is
    inactive may only be unloaded while the image models run."""

    def __init__(self, url, model, http_timeout=2.0):
        self.url, self.model, self.http_timeout = url.rstrip('/'), model, http_timeout
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _call(self, method, path, timeout):
        req = urllib.request.Request(self.url + path, method=method, data=b'' if method == 'POST' else None)
        try:
            with self._opener.open(req, timeout=timeout) as r:
                return r.status, r.read(65536)
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read(4096)
        except (OSError, ValueError) as e:
            return None, str(e).encode()

    def loaded(self):
        """True while llama-swap runs or starts the engine's model, False when it does not, None when it can't say."""
        status, body = self._call('GET', '/running', self.http_timeout)
        try:
            running = json.loads(body).get('running') if status == 200 else None
        except (ValueError, AttributeError):
            running = None
        if not isinstance(running, list):
            return None
        return any(isinstance(m, dict) and m.get('model') == self.model and m.get('state') in ('starting', 'ready')
                   for m in running)

    def unload_all(self, timeout):
        status, body = self._call('POST', '/api/models/unload', timeout)
        if status != 200:
            raise StepError(f'llama-swap did not unload its models: {status or body.decode("utf-8", "replace")}')

    def load(self, timeout):
        """Has llama-swap start the engine's model (stopping the others first) and returns once the model serves."""
        status, body = self._call('GET', f'/upstream/{urllib.parse.quote(self.model, safe="")}/v1/models', timeout)
        if status != 200:
            said = body.decode('utf-8', 'replace').strip()[-300:]
            raise StepError(f'llama-swap did not start {self.model}: {status or "no answer"} {said}'.rstrip())


def unit_of(quadlet):
    return os.path.basename(quadlet).removesuffix('.container') + '.service'


class Engine:
    def __init__(self, unit, quadlet, url, state_dir, runner=None, ready_timeout=600.0, restart_timeout=900.0,
                 poll=2.0, http_timeout=2.0, router=None):
        self.unit, self.quadlet, self.url = unit, quadlet, url.rstrip('/')
        self.prev_path = os.path.join(state_dir, unit.removesuffix('.service') + '.container.prev')
        self.state_dir = state_dir
        self.runner = runner or Runner()
        self.ready_timeout, self.restart_timeout = ready_timeout, restart_timeout
        self.poll, self.http_timeout = poll, http_timeout
        self.router = router
        self.lock = threading.Lock()
        self.job = None
        self._images_cache = (0.0, None)
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _read_quadlet(self, path=None):
        path = path or self.quadlet
        try:
            with open(path, 'rb') as f:
                return f.read().decode('utf-8', 'surrogateescape')
        except OSError as e:
            raise StepError(f'cannot read {path}: {e.strerror}')

    def companions(self):
        """The other quadlets beside the engine's with an image of its repository (the image models' units): they run
        the version the engine runs, so an apply rewrites them too. Sorted paths."""
        repo = repository_of(quadlet_image(self._read_quadlet())[1])
        found = []
        for path in sorted(glob.glob(os.path.join(glob.escape(os.path.dirname(self.quadlet)), '*.container'))):
            if os.path.abspath(path) == os.path.abspath(self.quadlet):
                continue
            try:
                image = quadlet_image(self._read_quadlet(path))[1]
            except StepError:
                continue
            if repository_of(image) == repo:
                found.append(path)
        return found

    def _image(self):
        """The quadlet's Image= value, for an API call: without one the answer is quadlet_invalid."""
        try:
            return quadlet_image(self._read_quadlet())[1]
        except StepError as e:
            raise ApiError(500, 'quadlet_invalid', str(e))

    def _http(self, path):
        try:
            with self._opener.open(self.url + path, timeout=self.http_timeout) as r:
                return r.status, r.read(65536)
        except urllib.error.HTTPError as e:
            return e.code, b''
        except (OSError, ValueError):
            return None, b''

    def ready(self):
        return self._http('/ready')[0] == 200

    def engine_said(self, since):
        """The engine's own last log lines since `since` (journalctl's @epoch), systemd's lines left out."""
        rc, out, _ = self.runner.run(['journalctl', '--user', '-u', self.unit, '--since', since,
                                      '-n', '200', '-o', 'json', '--no-pager'], 15)
        said = []
        for line in out.splitlines() if rc == 0 else []:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if entry.get('_COMM') != 'systemd' and isinstance(entry.get('MESSAGE'), str):
                said.append(entry['MESSAGE'])
        return '; the engine said:\n' + '\n'.join(said[-ENGINE_LOG_LINES:]) if said else ''

    def build_info(self):
        st, body = self._http('/props')
        if st != 200:
            return None
        try:
            v = json.loads(body).get('build_info')
            return v if isinstance(v, str) else None
        except (ValueError, AttributeError):
            return None

    def unit_state(self, unit=None):
        rc, out, _ = self.runner.run(['systemctl', '--user', 'show', unit or self.unit, '-p', 'ActiveState', '-p', 'SubState'], 15)
        props = dict(line.partition('=')[::2] for line in out.splitlines() if '=' in line)
        state = props.get('ActiveState', '') if rc == 0 else ''
        if state not in ('active', 'activating', 'deactivating', 'inactive', 'failed'):
            state = 'unknown'
        return state, (props.get('SubState') or None) if rc == 0 else None

    def images(self, repository, fresh=False):
        """Local images of repository, deduplicated by ID, newest first (podman listing cached 5 s)."""
        t, cached = self._images_cache
        if fresh or cached is None or time.monotonic() - t > STATUS_CACHE:
            rc, out, err = self.runner.run(self.runner.podman(['images', '--format', 'json']), 60)
            if rc != 0:
                raise StepError(f'podman images failed: {err.strip() or rc}')
            try:
                cached = json.loads(out or '[]') or []
            except ValueError:
                raise StepError('podman images returned invalid JSON')
            self._images_cache = (time.monotonic(), cached)
        seen, result = set(), []
        for im in cached:
            iid = im.get('Id') or im.get('ID') or ''
            if iid in seen:
                continue
            refs = list(im.get('RepoDigests') or [])
            digests = [r.split('@', 1)[1] for r in refs if r.startswith(repository + '@')]
            names = im.get('Names') or im.get('RepoTags') or []
            if not digests and not any(n.startswith((repository + ':', repository + '@')) for n in names):
                continue
            seen.add(iid)
            labels = im.get('Labels') or {}
            rev = labels.get('org.gufo.engine.revision') or labels.get('org.opencontainers.image.revision')
            created = im.get('Created')
            # RepoDigests is sorted and, for a multi-arch image, also holds the platform manifest digest;
            # podman's Digest field is the one the image was pulled by (the index digest a quadlet names).
            primary = im.get('Digest')
            result.append({'id': iid[:12], 'digests': digests,
                           'digest': primary if primary in digests else (digests[0] if digests else None),
                           'version': labels.get('org.opencontainers.image.version') or None,
                           'revision': None if not rev or rev == 'unknown' else rev,
                           'createdAt': int(created) * 1000 if isinstance(created, (int, float)) else None,
                           'sizeBytes': im.get('Size')})
        result.sort(key=lambda x: x['createdAt'] or 0, reverse=True)
        return result

    def image_exists(self, image):
        rc, _, _ = self.runner.run(self.runner.podman(['image', 'exists', image]), 60)
        return rc == 0

    def _previous_image(self):
        try:
            with open(self.prev_path, 'rb') as f:
                text = f.read().decode('utf-8', 'surrogateescape')
            return text, quadlet_image(text)[1]
        except (OSError, StepError):
            return None, None

    def status(self):
        job = self.job
        job_json = job.to_json() if job else None  # snapshot first: a finished job implies the quadlet below is final
        image = self._image()
        repo, cur_digest = repository_of(image), digest_of(image)
        prev_text, prev_image = self._previous_image()
        prev_digest = digest_of(prev_image)
        try:
            imgs = self.images(repo)
        except StepError as e:
            log(f'engine: {e}')
            imgs = []
        cur_img, prev_img = image_with(imgs, cur_digest), image_with(imgs, prev_digest)
        out_images = []
        for i in imgs:
            digest = cur_digest if cur_img is i else (prev_digest if prev_img is i else i['digest'])
            out_images.append({'id': i['id'], 'digest': digest, 'version': i['version'], 'revision': i['revision'],
                               'createdAt': i['createdAt'], 'sizeBytes': i['sizeBytes'],
                               'current': cur_img is i, 'previous': prev_img is i and cur_img is not i})
        state, sub = self.unit_state()
        ready = self.ready()
        # Behind llama-swap an inactive unit is the normal state while the image models run.
        unloaded = self.router is not None and state == 'inactive' and self.router.loaded() is False
        previous = None
        if prev_image:
            previous = {'image': prev_image, 'digest': prev_digest,
                        'version': (prev_img or {}).get('version') or doc_version(prev_text)}
        return {'unit': self.unit, 'quadlet': self.quadlet, 'repository': repo, 'image': image,
                'digest': cur_digest if cur_img else None,
                'version': cur_img['version'] if cur_img else None,
                'revision': cur_img['revision'] if cur_img else None,
                'state': state, 'subState': sub, 'ready': ready, 'unloaded': unloaded,
                'buildInfo': self.build_info() if ready else None,
                'previous': previous, 'images': out_images,
                'job': job_json}

    def _validate(self, image):
        if not isinstance(image, str) or not IMAGE_RE.fullmatch(image):
            raise ApiError(400, 'invalid_image', 'image must be <repository>@sha256:<64 hex>')
        repo = repository_of(self._image())
        if IMAGE_RE.fullmatch(image).group('repo') != repo:
            raise ApiError(400, 'wrong_repository', f'repository must be {repo}')

    def _busy(self):
        if self.job is not None and self.job.phase == 'running':
            raise ApiError(409, 'job_running', 'another engine job is running')

    def _start(self, job, target):
        with self.lock:
            self._busy()
            self.job = job
            snapshot = job.to_json()
        threading.Thread(target=self._wrap, args=(job, target), name='job-' + job.id, daemon=True).start()
        return snapshot

    def _wrap(self, job, target):
        try:
            target(job)
        except StepError as e:
            job.add(f'failed: {e}')
            job.phase, job.error = 'failed', str(e)
        except Exception as e:
            job.add(f'internal error: {type(e).__name__}: {e}')
            job.phase, job.error = 'failed', f'internal error: {e}'
        finally:
            self._images_cache = (0.0, None)
            job.finished_at = now_ms()
            if job.phase == 'running':
                job.phase = 'succeeded'

    def start_pull(self, image):
        self._validate(image)
        return self._start(Job('pull', image, None), self._pull)

    def _stop_pull(self, job):
        return self.runner.run(['systemctl', '--user', 'stop', f'portal-hostd-{job.id}.service'], 60)

    def _pull(self, job):
        job.set_step(f'Pulling {job.image}')
        rc = self.runner.stream(self.runner.podman(['pull', job.image], unit=f'portal-hostd-{job.id}'), job.add, 3600)
        if rc < 0:  # our timeout killed systemd-run; stop the transient unit as well
            self._stop_pull(job)
        if job.cancel_requested:
            job.phase, job.step, job.error = 'cancelled', 'Cancelled', 'cancelled by request'
            job.add('cancelled')
        elif rc != 0:
            job.phase, job.error = 'failed', f'podman pull exited with status {rc}'
            job.add(job.error)
        elif not self.image_exists(job.image):
            job.phase, job.error = 'failed', 'pull finished but the image is not present'
        else:
            job.set_step('Pulled')

    def cancel(self):
        job = self.job
        if job is None or job.phase != 'running' or job.kind != 'pull':
            return {'cancelled': False}
        job.cancel_requested = True
        rc, _, err = self._stop_pull(job)
        if rc != 0:
            job.cancel_requested = False
            job.add(f'cancel failed: {err.strip()}')
            return {'cancelled': False}
        return {'cancelled': True}

    def start_apply(self, image, version):
        self._validate(image)
        if version is not None and (not isinstance(version, str) or not VERSION_RE.fullmatch(version)):
            raise ApiError(400, 'invalid_version', 'version must be X.Y.Z or null')
        self._busy()
        if not self.image_exists(image):
            raise ApiError(409, 'not_pulled', 'pull the image first')
        return self._start(Job('apply', image, version), self._apply)

    def _restart_and_verify(self, job, version):
        job.set_step('Reloading systemd')
        rc, _, err = self.runner.run(['systemctl', '--user', 'daemon-reload'], 120)
        if rc != 0:
            raise StepError(f'daemon-reload failed: {err.strip() or rc}')
        since = f'@{int(time.time())}'
        if self.router is None:
            job.set_step(f'Restarting {self.unit}')
            rc, _, err = self.runner.run(['systemctl', '--user', 'restart', self.unit], self.restart_timeout)
            if rc != 0:
                raise StepError(f'restart failed: {err.strip() or rc}{self.engine_said(since)}')
        else:
            # llama-swap must see the units go and start them itself: a unit restarted behind its back would run
            # beside the image models.
            job.set_step('Stopping the models (llama-swap)')
            self.router.unload_all(self.restart_timeout)
            self._wait_stopped([self.unit] + [unit_of(q) for q in self.companions()])
            job.set_step(f'Starting {self.router.model} (llama-swap)')
            try:
                self.router.load(self.ready_timeout)
            except StepError as e:
                raise StepError(f'{e}{self.engine_said(since)}')
        job.set_step('Waiting for /ready')
        deadline = time.monotonic() + self.ready_timeout
        while not self.ready():
            if time.monotonic() > deadline:
                raise StepError(f'/ready did not answer 200 within {self.ready_timeout:.0f} s{self.engine_said(since)}')
            time.sleep(self.poll)
        if version:
            job.set_step('Checking version')
            info = self.build_info()
            if not info or not info.startswith(version + ' '):
                raise StepError(f'build_info is {info!r}, expected it to start with "{version} "')
            job.add(f'build_info {info}')

    def _wait_stopped(self, units):
        deadline = time.monotonic() + self.restart_timeout
        while any(self.unit_state(u)[0] not in ('inactive', 'failed') for u in units):
            if time.monotonic() > deadline:
                raise StepError(f'{", ".join(units)} did not stop within {self.restart_timeout:.0f} s')
            time.sleep(self.poll)

    def _write_all(self, texts):
        for path, data in texts.items():
            atomic_write(path, data)

    def _apply(self, job):
        job.set_step('Checking image')
        if not self.image_exists(job.image):
            raise StepError('image is not local')
        text = self._read_quadlet()
        old = text.encode('utf-8', 'surrogateescape')
        new = quadlet_rewrite(text, job.image, job.version).encode('utf-8', 'surrogateescape')
        # path -> (bytes before, bytes after) of the quadlets beside it that run the same image repository
        others = {}
        for path in self.companions():
            other = self._read_quadlet(path)
            others[path] = (other.encode('utf-8', 'surrogateescape'),
                            quadlet_rewrite(other, job.image, job.version).encode('utf-8', 'surrogateescape'))
        job.set_step('Saving current quadlet')
        os.makedirs(self.state_dir, exist_ok=True)
        try:
            with open(self.prev_path, 'rb') as f:
                saved_prev = f.read()
        except FileNotFoundError:
            saved_prev = None
        atomic_write(self.prev_path, old, 0o600)
        try:
            job.set_step('Writing quadlet' if not others else f'Writing {len(others) + 1} quadlets')
            self._write_all({self.quadlet: new, **{p: n for p, (_, n) in others.items()}})
            self._restart_and_verify(job, job.version)
        except (StepError, OSError) as e:
            job.add(f'failed: {e}')
            job.set_step('Rolling back')
            try:
                self._write_all({self.quadlet: old, **{p: o for p, (o, _) in others.items()}})
                self._restart_and_verify(job, None)
                job.rolled_back = True
                job.error = str(e)
                job.add('rolled back to the previous quadlet')
                job.set_step('Failed; the previous version runs again')
            except (StepError, OSError) as e2:
                job.error = f'{e}; rollback failed too: {e2}'
                job.add(f'rollback failed: {e2}')
                job.set_step('Failed; the rollback failed too')
            # The new image never took over, so the previous version on record stays what it was.
            try:
                if saved_prev is None:
                    os.remove(self.prev_path)
                else:
                    atomic_write(self.prev_path, saved_prev, 0o600)
            except OSError as e3:
                job.add(f'could not restore the saved previous quadlet: {e3}')
            job.phase = 'failed'
            return
        job.set_step('Done')

    def delete_image(self, digest):
        if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
            raise ApiError(400, 'invalid_image', 'digest must be sha256:<64 hex>')
        self._busy()
        current = self._image()
        repo = repository_of(current)
        try:
            imgs = self.images(repo, fresh=True)
        except StepError as e:
            raise ApiError(503, 'podman_failed', str(e))
        target = image_with(imgs, digest)
        if target is None:
            raise ApiError(404, 'not_found', 'no such local image of the engine repository')
        in_use = [current] + [quadlet_image(self._read_quadlet(p))[1] for p in self.companions()]
        if any(target is image_with(imgs, digest_of(image)) for image in in_use):
            raise ApiError(409, 'image_current', 'this is the engine image in use')
        rc, out, err = self.runner.run(self.runner.podman(['rmi', f'{repo}@{digest}']), 300)
        self._images_cache = (0.0, None)
        if rc != 0:
            raise ApiError(409, 'rmi_failed', (err or out).strip()[-500:] or f'podman rmi exited with {rc}')
        return {'ok': True}


class _DeadlineReader:
    """Stands in for rfile (http.server only calls these two) so that the request line, the headers and the
    body must arrive within HEADER_TIMEOUT in total."""

    def __init__(self, raw, sock, deadline):
        self.raw, self.sock, self.deadline = raw, sock, deadline

    def _arm(self):
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError('request headers too slow')
        self.sock.settimeout(left)

    def readline(self, *a):
        self._arm()
        return self.raw.readline(*a)

    def read(self, *a):
        self._arm()
        return self.raw.read(*a)


def compact(obj):
    return json.dumps(obj, separators=(',', ':'), allow_nan=False).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'portal-hostd/1'
    sys_version = ''
    timeout = HEADER_TIMEOUT

    def log_message(self, fmt, *args):
        pass

    def handle_one_request(self):
        raw = self.rfile
        self.rfile = _DeadlineReader(raw, self.connection, time.monotonic() + HEADER_TIMEOUT)
        try:
            super().handle_one_request()
        finally:
            self.rfile = raw
            try:
                self.connection.settimeout(HEADER_TIMEOUT)
            except OSError:
                pass

    def send_json(self, status, obj, extra=None):
        body = compact(obj)
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, code, message, extra=None):
        self.send_json(status, {'error': code, 'message': message}, extra)

    def body_json(self):
        if 'chunked' in (self.headers.get('Transfer-Encoding') or '').lower():
            self.close_connection = True
            raise ApiError(411, 'length_required', 'send a Content-Length body')
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            raise ApiError(400, 'bad_request', 'invalid Content-Length')
        if n > MAX_BODY:
            self.close_connection = True
            raise ApiError(413, 'body_too_large', f'request bodies are limited to {MAX_BODY} bytes')
        data = self.rfile.read(n) if n > 0 else b''
        if not data.strip():
            return {}
        try:
            obj = json.loads(data)
        except ValueError:
            raise ApiError(400, 'invalid_json', 'body is not valid JSON')
        if not isinstance(obj, dict):
            raise ApiError(400, 'invalid_json', 'body must be a JSON object')
        return obj

    def get_sample(self, app, body):
        s = app.sampler.current()
        if s is None:
            raise ApiError(503, 'no_sample', 'no sample available yet')
        self.send_json(200, s)

    def get_stream(self, app, body):
        if not app.sampler.add_stream():
            raise ApiError(429, 'too_many_streams', f'at most {MAX_STREAMS} streams')
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.send_header('X-Accel-Buffering', 'no')
            self.end_headers()
            self.wfile.write(b'event: info\ndata: ' + compact(app.host.info()) + b'\n\n')
            seq = 0
            while not app.sampler.stopping:
                seq, sample = app.sampler.wait_newer(seq, PING_EVERY)
                self.wfile.write(b': ping\n\n' if sample is None else b'event: sample\ndata: ' + compact(sample) + b'\n\n')
        except OSError:
            pass
        finally:
            app.sampler.remove_stream()

    ROUTES = {
        ('GET', '/v1/info'): lambda self, app, body: self.send_json(200, app.host.info()),
        ('GET', '/v1/sample'): get_sample,
        ('GET', '/v1/stream'): get_stream,
        ('GET', '/v1/meter'): lambda self, app, body: self.send_json(200, app.meter.snapshot()),
        ('GET', '/v1/engine'): lambda self, app, body: self.send_json(200, app.need_engine().status()),
        ('POST', '/v1/engine/pull'): lambda self, app, body: self.send_json(
            202, app.need_engine().start_pull(body.get('image'))),
        ('POST', '/v1/engine/apply'): lambda self, app, body: self.send_json(
            202, app.need_engine().start_apply(body.get('image'), body.get('version'))),
        ('POST', '/v1/engine/cancel'): lambda self, app, body: self.send_json(200, app.need_engine().cancel()),
    }

    def route(self):
        app, method = self.server.app, self.command
        path = self.path.split('?', 1)[0]
        try:
            body = {} if method == 'GET' else self.body_json()   # read even if unused: keep-alive, the size limit
            self.connection.settimeout(HEADER_TIMEOUT)  # for each write, so a stalled stream reader is dropped
            if path == '/v1/health':
                if method != 'GET':
                    raise ApiError(405, 'method_not_allowed', 'use GET')
                return self.send_json(200, {'ok': True})
            if not app.authorized(self.headers.get('Authorization')):
                return self.send_error_json(401, 'unauthorized', 'missing or wrong bearer token',
                                            {'WWW-Authenticate': 'Bearer'})
            handler = self.ROUTES.get((method, path))
            if handler is not None:
                return handler(self, app, body)
            if path.startswith('/v1/engine/images/'):
                if method != 'DELETE':
                    raise ApiError(405, 'method_not_allowed', 'use DELETE')
                digest = urllib.parse.unquote(path[len('/v1/engine/images/'):])
                return self.send_json(200, app.need_engine().delete_image(digest))
            if any(p == path for _, p in self.ROUTES):
                raise ApiError(405, 'method_not_allowed', f'{method} is not allowed here')
            raise ApiError(404, 'not_found', 'no such endpoint')
        except ApiError as e:
            self.send_error_json(e.status, e.code, e.message)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception as e:
            log(f'http: {method} {path}: {type(e).__name__}: {e}')
            try:
                self.send_error_json(500, 'internal', f'{type(e).__name__}')
            except OSError:
                self.close_connection = True

    do_GET = do_POST = do_DELETE = route


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True
    request_queue_size = 32

    def __init__(self, addr, app, max_connections=MAX_CONNECTIONS):
        self.address_family = socket.AF_INET6 if ':' in addr[0] else socket.AF_INET
        self.app = app
        self.slots = threading.BoundedSemaphore(max_connections)
        super().__init__(addr, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            body = b'{"error":"too_many_connections","message":"connection limit reached"}'
            try:
                request.settimeout(1)
                request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n'
                                b'Connection: close\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class App:
    def __init__(self, host, sampler, meter, token, engine=None):
        self.host, self.sampler, self.meter, self.engine = host, sampler, meter, engine
        self.token = token.encode()

    def authorized(self, header):
        return (header or '').startswith('Bearer ') and hmac.compare_digest(header[7:].strip().encode(), self.token)

    def need_engine(self):
        if self.engine is None:
            raise ApiError(404, 'no_engine', 'this host has no engine control')
        return self.engine


def load_token():
    cred = os.environ.get('CREDENTIALS_DIRECTORY')
    path = os.path.join(cred, 'token') if cred else os.environ.get('HOSTD_TOKEN_FILE')
    if not path:
        raise SystemExit('portal-hostd: no token (LoadCredential=token:... or HOSTD_TOKEN_FILE)')
    try:
        with open(path, encoding='utf-8') as f:
            token = f.read().strip()
    except OSError as e:
        raise SystemExit(f'portal-hostd: cannot read token {path}: {e.strerror}')
    if len(token) < 32 or any(c.isspace() for c in token):
        raise SystemExit('portal-hostd: the token must be at least 32 characters without whitespace')
    return token


def config(env):
    role = env.get('ROLE', 'portal').strip()
    if role not in ('portal', 'llm'):
        raise SystemExit(f'portal-hostd: ROLE must be portal or llm, not {role!r}')
    bind = env.get('BIND', '127.0.0.1' if role == 'portal' else '0.0.0.0').strip()
    try:
        port = int(env.get('PORT', DEFAULT_PORT))
        interval = int(env.get('INTERVAL_MS', 500))
    except ValueError:
        raise SystemExit('portal-hostd: PORT and INTERVAL_MS must be integers')
    if not 1 <= port <= 65535:
        raise SystemExit('portal-hostd: PORT out of range')
    if not 250 <= interval <= 5000:
        raise SystemExit('portal-hostd: INTERVAL_MS must be within 250..5000')
    unit = env.get('ENGINE_UNIT', '').strip() if role == 'llm' else ''
    if unit and not unit.endswith('.service'):
        unit += '.service'
    home = pwd.getpwuid(os.getuid()).pw_dir
    quadlet = env.get('ENGINE_QUADLET', '').strip() or (
        os.path.join(home, '.config/containers/systemd', unit.removesuffix('.service') + '.container') if unit else '')
    router_url = env.get('ENGINE_ROUTER_URL', '').strip() if unit else ''
    router_model = env.get('ENGINE_ROUTER_MODEL', '').strip() if unit else ''
    if bool(router_url) != bool(router_model):
        raise SystemExit('portal-hostd: ENGINE_ROUTER_URL and ENGINE_ROUTER_MODEL go together')
    return {'role': role, 'bind': bind, 'port': port, 'interval_ms': interval, 'engine_unit': unit,
            'engine_quadlet': quadlet, 'engine_url': env.get('ENGINE_URL', '').strip() or 'http://127.0.0.1:8080',
            'engine_router': (router_url, router_model) if router_url else None,
            'state_dir': os.path.join(home, '.local/state/portal-hostd'),
            'root': env.get('HOSTD_ROOT', '')}


def sd_notify(msg):
    addr = os.environ.get('NOTIFY_SOCKET')
    if not addr:
        return
    if addr.startswith('@'):
        addr = '\0' + addr[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as s:
            s.sendto(msg.encode(), addr)
    except OSError:
        pass


def build(cfg, token):
    host = Host(Fs(cfg['root']), cfg['role'], cfg['interval_ms'], cfg['engine_unit'] or None)
    engine = None
    if cfg['engine_unit']:
        router = Router(*cfg['engine_router']) if cfg['engine_router'] else None
        engine = Engine(cfg['engine_unit'], cfg['engine_quadlet'], cfg['engine_url'], cfg['state_dir'], router=router)
    return App(host, Sampler(host, cfg['interval_ms'] / 1000.0), Meter(host), token, engine)


def main(argv):
    cfg = config(os.environ)
    if '--print-info' in argv or '--print-sample' in argv:
        app = build(cfg, 'x' * 32)
        if '--print-info' in argv:
            print(json.dumps(app.host.info(), indent=1))
        if '--print-sample' in argv:
            app.host.open_perf()
            a = app.host.read()
            time.sleep(cfg['interval_ms'] / 1000.0)
            print(json.dumps(app.host.compute(a, app.host.read(), app.host.fans.read()), indent=1))
        return 0
    app = build(cfg, load_token())
    if app.engine and not os.path.exists(app.engine.quadlet):
        log(f'portal-hostd: warning: quadlet {app.engine.quadlet} does not exist')
    server = Server((cfg['bind'], cfg['port']), app)
    app.sampler.start()
    app.meter.start()
    for sig in (signal.SIGTERM, signal.SIGINT):     # both end serve_forever with a KeyboardInterrupt
        signal.signal(sig, signal.default_int_handler)
    src = app.host.sources()
    log(f'portal-hostd: role={cfg["role"]} listening on {cfg["bind"]}:{cfg["port"]} interval={cfg["interval_ms"]}ms '
        f'perf={src["perf"]} bandwidth={src["bandwidth"]} power={src["power"]} gpuBusy={src["gpuBusy"]} '
        f'energy={"on" if app.meter.energy is not None else "off"} engine={cfg["engine_unit"] or "-"}'
        f'{" router=" + cfg["engine_router"][0] if cfg["engine_router"] else ""}')
    sd_notify('READY=1')
    try:
        server.serve_forever(poll_interval=None)  # no periodic wakeups
    except KeyboardInterrupt:
        pass
    finally:
        sd_notify('STOPPING=1')
        app.sampler.stop()
        app.meter.stop()
        app.host.close_perf()
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
