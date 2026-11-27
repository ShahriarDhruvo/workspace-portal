#!/usr/bin/python3
"""Fan curve for the Bosgame M5: both main fans follow the hotter of CPU and GPU.

Needs the ec_su_axb35 module next to this file. It loads on the tested board and BIOS only, checks every write,
and hands a fan back to the firmware when no duty arrives for 10 seconds.
"""
import signal
import sys
import time
from pathlib import Path

EC = Path('/sys/class/ec_su_axb35')
FANS = ('fan1', 'fan2')
FULL = 99  # top speed: at 100 the EC lets both fans fall to half speed or less


def target_duty(temp, previous):
    """Percent for a temperature in °C; 0 leaves the fans to the firmware."""
    if temp >= 70 or previous == FULL and temp >= 67:
        return FULL
    if temp >= 60 or previous > 0 and temp >= 55:
        return min(95, max(50, 50 + (temp - 60) * 5))
    return 0


def temperature(hwmon=Path('/sys/class/hwmon')):
    readings = {}
    for sensor in hwmon.glob('hwmon*'):
        try:
            name = (sensor / 'name').read_text().strip()
            if name in ('k10temp', 'amdgpu'):
                value = int((sensor / 'temp1_input').read_text())
                if 0 <= value <= 125000:
                    readings[name] = value
        except (OSError, ValueError):
            continue
    if len(readings) != 2:
        raise RuntimeError('no plausible reading from both k10temp and amdgpu')
    return max(readings.values()) // 1000


def write_duty(duty, ec=EC):
    # Written every time, changed or not: it renews the module's 10-second hold.
    for fan in FANS:
        error = int((ec / fan / 'duty_error').read_text())
        if error:
            raise RuntimeError(f'{fan}: EC duty error {error}')
        (ec / fan / 'duty').write_text(f'{duty}\n')


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    duty, blind = 0, False
    try:
        while True:
            try:
                duty = target_duty(temperature(), duty)
                if blind:
                    print('temperature readings are back', flush=True)
                blind = False
            except RuntimeError as exc:
                if not blind:
                    print(f'{exc}: {FULL}% until they return', file=sys.stderr, flush=True)
                duty, blind = FULL, True
            write_duty(duty)
            time.sleep(2)
    finally:
        for fan in FANS:
            try:
                (EC / fan / 'duty').write_text('0\n')
            except OSError as exc:
                print(f'{fan}: not released ({exc})', file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as exc:
        sys.exit(str(exc))
